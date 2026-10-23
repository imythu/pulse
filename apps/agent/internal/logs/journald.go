package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// JournaldSource 通过 journalctl -f 读取 systemd 日志。Units 为空表示全部。
// Service 为空时用 unit 名（去掉 .service）或 SYSLOG_IDENTIFIER 作为服务名。
type JournaldSource struct {
	Service string
	Units   []string
}

type journalEntry struct {
	Message    any    `json:"MESSAGE"`
	Priority   string `json:"PRIORITY"`
	Unit       string `json:"_SYSTEMD_UNIT"`
	Identifier string `json:"SYSLOG_IDENTIFIER"`
	Transport  string `json:"_TRANSPORT"`
}

func (s JournaldSource) run(ctx context.Context, cls *Classifier, emit func(Record), log *slog.Logger) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		log.Info("未找到 journalctl，跳过 journald 日志")
		return
	}
	args := []string{"-f", "-o", "json", "-n", "0", "--no-pager"}
	for _, u := range s.Units {
		args = append(args, "-u", u)
	}
	asms := map[string]*assembler{}
	for {
		start := time.Now()
		err := s.follow(ctx, args, cls, emit, asms)
		if ctx.Err() != nil {
			return
		}
		log.Warn("journalctl 退出，稍后重启", "err", err)
		// journalctl 反复立即退出（如没有读取权限）时不要空转
		wait := 10 * time.Second
		if time.Since(start) < 5*time.Second {
			wait = time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (s JournaldSource) follow(ctx context.Context, args []string, cls *Classifier, emit func(Record), asms map[string]*assembler) error {
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	lines := make(chan []byte, 256)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
	}()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			for _, a := range asms {
				a.FlushIdle(now, idleFlush)
			}
		case raw, ok := <-lines:
			if !ok {
				return cmd.Wait()
			}
			s.entry(raw, cls, emit, asms)
		}
	}
}

func (s JournaldSource) entry(raw []byte, cls *Classifier, emit func(Record), asms map[string]*assembler) {
	var e journalEntry
	if json.Unmarshal(raw, &e) != nil {
		return
	}
	msg := journalMessage(e.Message)
	if msg == "" {
		return
	}
	stream := e.Unit
	if stream == "" {
		stream = e.Identifier
	}
	if e.Transport == "kernel" {
		stream = "kernel"
	}
	a := asms[stream]
	if a == nil {
		service := s.Service
		if service == "" {
			service = strings.TrimSuffix(stream, ".service")
		}
		if service == "" {
			service = "journald"
		}
		a = newAssembler(service, "journald:"+stream, cls, emit)
		asms[stream] = a
	}
	now := time.Now()
	if e.Transport == "stdout" && e.Priority != "3" && e.Priority != "2" {
		// 服务直接写 stdout 的日志一行一条，堆栈被拆成多条，需要按行合并
		for _, l := range strings.Split(msg, "\n") {
			a.Feed(l, now)
		}
		return
	}
	a.FeedRecord(msg, journalLevel(cls, e.Priority, msg), now)
}

// journalLevel：PRIORITY 0–2 为 fatal，3 为 error；更低优先级的消息再按内容判断，
// 比如内核的 segfault、OOM 消息优先级只是 info / warning。
func journalLevel(cls *Classifier, priority, msg string) string {
	if p, err := strconv.Atoi(priority); err == nil {
		switch {
		case p <= 2:
			return LevelFatal
		case p == 3:
			return LevelError
		}
	}
	level, _ := cls.Classify(msg)
	return level
}

// MESSAGE 可能是字符串，也可能是字节数组（包含非 UTF-8 内容时）。
func journalMessage(v any) string {
	switch m := v.(type) {
	case string:
		return m
	case []any:
		b := make([]byte, 0, len(m))
		for _, x := range m {
			if f, ok := x.(float64); ok {
				b = append(b, byte(f))
			}
		}
		return string(b)
	}
	return ""
}
