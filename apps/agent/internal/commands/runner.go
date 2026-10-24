package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"pulse/agent/internal/protocol"
)

const (
	// OutputLimit：输出上限 1 MB，超出部分截断并标记
	OutputLimit   = 1 << 20
	maxConcurrent = 2
	chunkInterval = 300 * time.Millisecond
	niceness      = 10
)

// Custom 是 Agent 本地配置的自定义模板：参数用 {name} 整体替换到 argv 里，不经过 shell。
type Custom struct {
	Template protocol.CommandTemplate
	Exec     []string
}

type Options struct {
	// 为空时允许全部只读内置模板和自定义模板；写操作（risk=write）必须显式列出
	Allow []string
	// log.tail / log.grep 允许读取的文件 glob（日志采集配置的 + commands.log_paths）
	LogGlobs []string
	// 是否允许读 journald
	Journald bool
	Custom   []Custom
}

// Sender 把状态、输出和结果交给连接层。Done 必须可靠送达（写本地队列）。
type Sender interface {
	Status(id string)
	Output(id, data string)
	Done(p protocol.CmdDonePayload)
}

type Runner struct {
	v    *Verifier
	opts Options
	send Sender
	log  *slog.Logger
	sem  chan struct{}

	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func NewRunner(v *Verifier, opts Options, send Sender, log *slog.Logger) *Runner {
	return &Runner{v: v, opts: opts, send: send, log: log, sem: make(chan struct{}, maxConcurrent), running: map[string]context.CancelFunc{}}
}

// Templates 返回在 hello 中上报的自定义模板。
func (r *Runner) Templates() []protocol.CommandTemplate {
	out := make([]protocol.CommandTemplate, 0, len(r.opts.Custom))
	for _, c := range r.opts.Custom {
		out = append(out, c.Template)
	}
	return out
}

func (r *Runner) allowed(t protocol.CommandTemplate) bool {
	for _, a := range r.opts.Allow {
		if a == t.Name {
			return true
		}
	}
	return len(r.opts.Allow) == 0 && t.Risk == "read"
}

func (r *Runner) resolve(name string) (protocol.CommandTemplate, []string, bool) {
	if t, ok := Builtin(name); ok {
		return t, nil, true
	}
	for _, c := range r.opts.Custom {
		if c.Template.Name == name {
			return c.Template, c.Exec, true
		}
	}
	return protocol.CommandTemplate{}, nil, false
}

// Handle 处理一条 cmd.run：校验不通过立即回报 rejected，通过后排队执行（最多 2 条并发）。
func (r *Runner) Handle(ctx context.Context, p protocol.CmdRunPayload) {
	cmd, err := r.v.Verify(p)
	if err != nil {
		r.rejectRaw(p.Body, cmd.ID, err)
		return
	}
	tpl, argv, ok := r.resolve(cmd.Template)
	if !ok {
		r.rejected(cmd.ID, reject("本机没有模板 %s", cmd.Template))
		return
	}
	if !r.allowed(tpl) {
		r.rejected(cmd.ID, reject("本机 commands.allow 不允许 %s", tpl.Name))
		return
	}
	args, err := Validate(tpl, cmd.Args)
	if err != nil {
		r.rejected(cmd.ID, reject("%v", err))
		return
	}
	timeout := time.Duration(min(max(cmd.TimeoutSeconds, 1), tpl.TimeoutSeconds)) * time.Second

	runCtx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	r.running[cmd.ID] = cancel
	r.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			r.mu.Lock()
			delete(r.running, cmd.ID)
			r.mu.Unlock()
		}()
		// 排队等待执行槽，等到过期还没轮到就放弃
		wait, stop := context.WithDeadline(runCtx, time.UnixMilli(cmd.ExpiresAt))
		select {
		case r.sem <- struct{}{}:
			stop()
		case <-wait.Done():
			stop()
			status := "failed"
			if runCtx.Err() != nil {
				status = "canceled"
			}
			r.send.Done(protocol.CmdDonePayload{ID: cmd.ID, Status: status, Error: "排队等待执行时已过期或被取消"})
			return
		}
		defer func() { <-r.sem }()
		r.execute(runCtx, cmd.ID, tpl, argv, args, timeout)
	}()
}

// Cancel 中断执行中或排队中的指令。
func (r *Runner) Cancel(id string) {
	r.mu.Lock()
	cancel := r.running[id]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Reject 不校验直接拒绝（本机关闭了指令执行）。
func (r *Runner) Reject(p protocol.CmdRunPayload, reason string) {
	r.rejectRaw(p.Body, "", reject("%s", reason))
}

func (r *Runner) rejectRaw(body, id string, err error) {
	if id == "" {
		var probe struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(body), &probe)
		id = probe.ID
	}
	if id == "" {
		r.log.Warn("拒绝无法识别的指令", "err", err)
		return
	}
	r.rejected(id, err)
}

func (r *Runner) rejected(id string, err error) {
	r.log.Warn("拒绝指令", "id", id, "err", err)
	r.send.Done(protocol.CmdDonePayload{ID: id, Status: "rejected", Error: strings.TrimPrefix(err.Error(), ErrRejected.Error()+"：")})
}

func (r *Runner) execute(ctx context.Context, id string, tpl protocol.CommandTemplate, argv []string, args map[string]string, timeout time.Duration) {
	start := time.Now()
	r.send.Status(id)
	out := newOutput(func(chunk string) { r.send.Output(id, chunk) })
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var code int
	var err error
	if argv != nil {
		code, err = r.runCustom(ctx, argv, args, out)
	} else {
		code, err = r.runBuiltin(ctx, tpl.Name, args, out)
	}
	text, truncated := out.Close()

	done := protocol.CmdDonePayload{ID: id, Output: text, Truncated: truncated, DurationMs: float64(time.Since(start).Milliseconds())}
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		done.Status, done.Error = "timeout", fmt.Sprintf("超过 %s 未完成，已中断", timeout)
	case errors.Is(ctx.Err(), context.Canceled):
		done.Status, done.Error = "canceled", "已取消"
	case err != nil:
		done.Status, done.Error = "failed", err.Error()
	case code != 0:
		done.Status = "failed"
	default:
		done.Status = "succeeded"
	}
	if code >= 0 && (argv != nil || usesExec(tpl.Name)) {
		c := code
		done.ExitCode = &c
	}
	r.send.Done(done)
}

func (r *Runner) runCustom(ctx context.Context, argv []string, args map[string]string, out *Output) (int, error) {
	full := make([]string, len(argv))
	for i, a := range argv {
		for k, v := range args {
			a = strings.ReplaceAll(a, "{"+k+"}", v)
		}
		full[i] = a
	}
	return runExec(ctx, out, full[0], full[1:]...)
}

// runExec 直接 exec（不经过 shell），降低优先级，超时或取消时杀掉整个进程组。
func runExec(ctx context.Context, out *Output, name string, args ...string) (int, error) {
	c := exec.Command(name, args...)
	c.Stdout, c.Stderr = out, out
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "SYSTEMD_PAGER=", "SYSTEMD_COLORS=0"}
	if err := c.Start(); err != nil {
		return -1, fmt.Errorf("无法执行 %s：%w", name, err)
	}
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, c.Process.Pid, niceness)
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case err := <-done:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		if err != nil {
			return -1, err
		}
		return 0, nil
	case <-ctx.Done():
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		<-done
		return -1, ctx.Err()
	}
}

// Output 收集输出：总量超过上限后截断，并每 300 毫秒把新增部分作为分片推送给控制台。
type Output struct {
	mu        sync.Mutex
	buf       []byte
	sent      int
	truncated bool
	emit      func(string)
	stop      chan struct{}
	wg        sync.WaitGroup
}

func newOutput(emit func(string)) *Output {
	o := &Output{emit: emit, stop: make(chan struct{})}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		t := time.NewTicker(chunkInterval)
		defer t.Stop()
		for {
			select {
			case <-o.stop:
				return
			case <-t.C:
				o.flush()
			}
		}
	}()
	return o
}

func (o *Output) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if room := OutputLimit - len(o.buf); room < len(p) {
		o.truncated = true
		if room > 0 {
			o.buf = append(o.buf, p[:room]...)
		}
		return len(p), nil
	}
	o.buf = append(o.buf, p...)
	return len(p), nil
}

func (o *Output) WriteString(s string) { _, _ = o.Write([]byte(s)) }

func (o *Output) Printf(format string, a ...any) { o.WriteString(fmt.Sprintf(format, a...)) }

func (o *Output) flush() {
	o.mu.Lock()
	end := len(o.buf)
	// 分片不切断多字节字符，不完整的尾部留到下一片
	for i := 0; i < utf8.UTFMax && end-i > o.sent; i++ {
		if r, size := utf8.DecodeLastRune(o.buf[o.sent : end-i]); r != utf8.RuneError || size > 1 {
			end -= i
			break
		}
	}
	chunk := string(o.buf[o.sent:end])
	o.sent = end
	o.mu.Unlock()
	if chunk != "" {
		o.emit(strings.ToValidUTF8(chunk, "�"))
	}
}

// Close 停止推送，返回完整输出。
func (o *Output) Close() (string, bool) {
	close(o.stop)
	o.wg.Wait()
	o.flush()
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.ToValidUTF8(string(o.buf), "�"), o.truncated
}
