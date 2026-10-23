// Package agent 把采集、本地队列和连接组织在一起。
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"pulse/agent/internal/aggregate"
	"pulse/agent/internal/collect"
	"pulse/agent/internal/config"
	"pulse/agent/internal/identity"
	"pulse/agent/internal/protocol"
	"pulse/agent/internal/queue"
	"pulse/agent/internal/transport"
)

// 服务器用这些关闭码表示 Agent 不应再重连（凭证被吊销、主机被删除）。
const closeRevoked = 4401

const (
	diskEveryNSamples = 3 // 磁盘容量每 30 秒采一次
	topProcs          = 10
	sendBatch         = 50
)

type Agent struct {
	cfg     *config.Config
	id      *identity.Identity
	q       *queue.Queue
	log     *slog.Logger
	version string
	started time.Time

	remote atomic.Pointer[protocol.Config]
	notify chan struct{}
	self   *process.Process
}

func New(cfg *config.Config, version string, log *slog.Logger) (*Agent, error) {
	id, err := identity.Load(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	q, err := queue.Open(cfg.DataDir, cfg.QueueMaxBytes)
	if err != nil {
		return nil, fmt.Errorf("打开本地队列：%w", err)
	}
	a := &Agent{
		cfg: cfg, id: id, q: q, log: log, version: version, started: time.Now(),
		notify: make(chan struct{}, 1),
	}
	def := protocol.DefaultConfig
	a.remote.Store(&def)
	a.self, _ = process.NewProcess(int32(os.Getpid()))
	return a, nil
}

func (a *Agent) Run(ctx context.Context) error {
	defer a.q.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.collectLoop(ctx) }()
	go func() { defer wg.Done(); a.procsLoop(ctx) }()
	err := a.connectLoop(ctx)
	wg.Wait()
	return err
}

func (a *Agent) conf() protocol.Config { return *a.remote.Load() }

// enqueue 把一条可靠消息写入本地队列并唤醒发送端。
func (a *Agent) enqueue(typ string, payload any) {
	_, err := a.q.Push(typ, func(seq int64) ([]byte, error) {
		return json.Marshal(protocol.Envelope[any]{Type: typ, Seq: seq, Ts: time.Now().UnixMilli(), Payload: payload})
	})
	if err != nil {
		a.log.Error("写入本地队列失败", "type", typ, "err", err)
		return
	}
	select {
	case a.notify <- struct{}{}:
	default:
	}
}

// collectLoop 按采样间隔采集，按与整分钟对齐的窗口聚合上报；超过本地阈值时提前推送当前窗口。
func (a *Agent) collectLoop(ctx context.Context) {
	sys := collect.NewSystem(a.cfg.IgnoreFSTypes)
	win := aggregate.NewWindow()
	sys.Collect(ctx, false) // 建立速率类指标的基线

	c := a.conf()
	windowLen := time.Duration(c.WindowSeconds) * time.Second
	windowStart := time.Now().Truncate(windowLen)
	earlySent := false

	for n := 0; ; n++ {
		c = a.conf()
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(c.SampleIntervalSeconds) * time.Second):
		}

		now := time.Now()
		if now.Sub(windowStart) >= windowLen {
			if pts := win.Flush(); len(pts) > 0 {
				a.enqueue(protocol.TypeMetrics, protocol.MetricsPayload{
					WindowStart: windowStart.UnixMilli(), WindowSeconds: c.WindowSeconds, Points: pts,
				})
			}
			windowLen = time.Duration(c.WindowSeconds) * time.Second
			windowStart = now.Truncate(windowLen)
			earlySent = false
		}

		over := false
		for _, s := range sys.Collect(ctx, n%diskEveryNSamples == 0) {
			win.Add(s.Name, s.Tag, s.Value)
			over = over || exceeds(s, c.EarlyPush)
		}
		if over && !earlySent {
			earlySent = true
			a.log.Info("指标超过本地阈值，提前推送当前窗口")
			a.enqueue(protocol.TypeMetrics, protocol.MetricsPayload{
				WindowStart: windowStart.UnixMilli(), WindowSeconds: c.WindowSeconds, Early: true, Points: win.Snapshot(),
			})
		}
	}
}

func exceeds(s collect.Sample, t protocol.EarlyPush) bool {
	switch s.Name {
	case collect.CPUUsage:
		return s.Value >= t.CPUPct
	case collect.MemUsed:
		return s.Value >= t.MemPct
	case collect.DiskUsed:
		return s.Value >= t.DiskPct
	}
	return false
}

func (a *Agent) procsLoop(ctx context.Context) {
	p := collect.NewProcs()
	p.Top(ctx, topProcs) // 建立 CPU 时间基线
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(a.conf().ProcsIntervalSeconds) * time.Second):
		}
		a.enqueue(protocol.TypeProcs, p.Top(ctx, topProcs))
	}
}

var errRevoked = errors.New("服务器已吊销本 Agent 的凭证，停止重连")

func (a *Agent) connectLoop(ctx context.Context) error {
	var bo transport.Backoff
	for {
		start := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if transport.CloseCode(err) == closeRevoked {
			return errRevoked
		}
		// 连接稳定超过 1 分钟后断开，下次从最短间隔开始重连
		if time.Since(start) > time.Minute {
			bo.Reset()
		}
		wait := bo.Next()
		a.log.Warn("与服务器的连接断开，稍后重连", "err", err, "retryIn", wait.Round(time.Millisecond).String())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

type serverMsg struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// session 处理一条连接的完整生命周期，连接断开时返回。
func (a *Agent) session(ctx context.Context) error {
	conn, err := transport.Dial(ctx, a.cfg.WebSocketURL(), a.id.AuthHeader(time.Now()), "pulse-agent/"+a.version)
	if err != nil {
		return err
	}
	defer conn.Close("bye")
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	hello := protocol.HelloPayload{Protocol: protocol.Version, AgentVersion: a.version, Host: collect.HostInfo(ctx, a.cfg.Labels)}
	if err := conn.Send(ctx, protocol.Envelope[protocol.HelloPayload]{Type: protocol.TypeHello, Ts: time.Now().UnixMilli(), Payload: hello}); err != nil {
		return err
	}
	a.log.Info("已连接服务器", "server", a.cfg.Server)

	acked := make(chan int64, 16)
	readErr := make(chan error, 1)
	go func() { readErr <- a.readLoop(ctx, conn, acked) }()

	// 收到服务器对 hello 的 ack 后才开始补传，避免重发服务器已处理的消息
	var sentUpTo int64
	select {
	case err := <-readErr:
		return err
	case sentUpTo = <-acked:
	case <-time.After(30 * time.Second):
		return errors.New("等待服务器确认超时")
	}

	heartbeat := time.NewTicker(time.Duration(a.conf().HeartbeatSeconds) * time.Second)
	defer heartbeat.Stop()
	for {
		if err := a.flush(ctx, conn, &sentUpTo); err != nil {
			return err
		}
		select {
		case err := <-readErr:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-a.notify:
		case <-acked:
		case <-heartbeat.C:
			if err := conn.Send(ctx, protocol.Envelope[protocol.HeartbeatPayload]{
				Type: protocol.TypeHeartbeat, Ts: time.Now().UnixMilli(), Payload: a.heartbeat(),
			}); err != nil {
				return err
			}
		}
	}
}

// flush 发送所有 seq > sentUpTo 的待确认消息。
func (a *Agent) flush(ctx context.Context, conn *transport.Conn, sentUpTo *int64) error {
	for {
		msgs, err := a.q.Pending(*sentUpTo, sendBatch)
		if err != nil || len(msgs) == 0 {
			return err
		}
		for _, m := range msgs {
			if err := conn.SendRaw(ctx, m.Data); err != nil {
				return err
			}
			*sentUpTo = m.Seq
		}
	}
}

func (a *Agent) readLoop(ctx context.Context, conn *transport.Conn, acked chan<- int64) error {
	for {
		data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var msg serverMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			a.log.Warn("无法解析服务器消息", "err", err)
			continue
		}
		switch msg.Type {
		case protocol.TypeAck:
			var p protocol.AckPayload
			if json.Unmarshal(msg.Payload, &p) == nil {
				if err := a.q.Ack(p.MaxSeq); err != nil {
					a.log.Error("确认本地队列失败", "err", err)
				}
				select {
				case acked <- p.MaxSeq:
				default:
				}
			}
		case protocol.TypeConfig:
			var c protocol.Config
			if json.Unmarshal(msg.Payload, &c) == nil && c.SampleIntervalSeconds > 0 && c.WindowSeconds > 0 {
				a.remote.Store(&c)
			}
		}
	}
}

func (a *Agent) heartbeat() protocol.HeartbeatPayload {
	hb := protocol.HeartbeatPayload{QueueDepth: a.q.Depth(), UptimeSeconds: time.Since(a.started).Seconds()}
	if a.self != nil {
		if v, err := a.self.Percent(0); err == nil {
			hb.CPUPct = v
		}
		if v, err := a.self.MemoryPercent(); err == nil {
			hb.MemPct = float64(v)
		}
	}
	return hb
}
