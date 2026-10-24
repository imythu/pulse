package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pulse/agent/internal/protocol"
)

func TestTemplatesInSync(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/shared/commands/templates.json")
	if err != nil {
		t.Skipf("不在 monorepo 中运行：%v", err)
	}
	if !bytes.Equal(src, templatesJSON) {
		t.Fatal("templates.json 与 packages/shared/commands/templates.json 不一致，运行 make rules 同步")
	}
}

type signer struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

func newSigner(t *testing.T) signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{priv, pub}
}

func (s signer) run(c protocol.SignedCommand) protocol.CmdRunPayload {
	body, _ := json.Marshal(c)
	return protocol.CmdRunPayload{Body: string(body), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, body))}
}

func cmd(id, template string, args map[string]string) protocol.SignedCommand {
	return protocol.SignedCommand{V: 1, Kind: "pulse-command", ID: id, HostID: "host-1", Template: template, Args: args,
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), TimeoutSeconds: 30}
}

// 验收（设计文档 12.3 M3）：未签名、签名错误、过期、发错主机、重放的指令都被拒绝。
func TestVerifyRejects(t *testing.T) {
	s := newSigner(t)
	other := newSigner(t)
	dir := t.TempDir()
	v := NewVerifier(s.pub, "host-1", dir)

	ok := s.run(cmd("c1", "proc.top", nil))
	if _, err := v.Verify(ok); err != nil {
		t.Fatalf("合法指令被拒绝：%v", err)
	}

	unsigned := ok
	unsigned.Signature = ""
	tampered := s.run(cmd("c2", "proc.top", nil))
	tampered.Body = strings.Replace(tampered.Body, "proc.top", "svc.restart", 1)
	expired := cmd("c3", "proc.top", nil)
	expired.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	wrongHost := cmd("c4", "proc.top", nil)
	wrongHost.HostID = "host-2"

	cases := map[string]protocol.CmdRunPayload{
		"未签名":    unsigned,
		"内容被篡改":  tampered,
		"其他密钥签名": other.run(cmd("c5", "proc.top", nil)),
		"已过期":    s.run(expired),
		"发给其他主机": s.run(wrongHost),
		"重放":     ok,
	}
	for name, p := range cases {
		if _, err := v.Verify(p); err == nil {
			t.Errorf("%s：应被拒绝", name)
		}
	}

	// 重启后（重新加载已执行记录）仍然拒绝重放
	v2 := NewVerifier(s.pub, "host-1", dir)
	if _, err := v2.Verify(ok); err == nil {
		t.Error("重启后重放应被拒绝")
	}
	// 没有公钥时一律拒绝
	if _, err := NewVerifier(nil, "host-1", t.TempDir()).Verify(s.run(cmd("c6", "proc.top", nil))); err == nil {
		t.Error("没有公钥时应拒绝")
	}
}

func TestValidate(t *testing.T) {
	tail, _ := Builtin("log.tail")
	got, err := Validate(tail, map[string]string{"source": "/var/log/app.log"})
	if err != nil || got["n"] != "200" {
		t.Fatalf("默认值：%v %v", got, err)
	}
	bad := []map[string]string{
		{"source": "/var/log/app.log", "n": "5000"},
		{"source": "/var/log/../../etc/shadow"},
		{"source": "relative.log"},
		{"source": "/var/log/app.log", "extra": "1"},
		{},
	}
	for _, args := range bad {
		if _, err := Validate(tail, args); err == nil {
			t.Errorf("%v 应校验失败", args)
		}
	}
	grep, _ := Builtin("log.grep")
	if _, err := Validate(grep, map[string]string{"source": "/a.log", "pattern": "x", "since": "30d"}); err == nil {
		t.Error("since 超过 7 天应失败")
	}
}

type fakeSender struct {
	mu     sync.Mutex
	done   map[string]protocol.CmdDonePayload
	output map[string]string
	ch     chan string
}

func (f *fakeSender) Status(string) {}
func (f *fakeSender) Output(id, data string) {
	f.mu.Lock()
	f.output[id] += data
	f.mu.Unlock()
}
func (f *fakeSender) Done(p protocol.CmdDonePayload) {
	f.mu.Lock()
	f.done[p.ID] = p
	f.mu.Unlock()
	f.ch <- p.ID
}

func (f *fakeSender) wait(t *testing.T, id string) protocol.CmdDonePayload {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		f.mu.Lock()
		d, ok := f.done[id]
		f.mu.Unlock()
		if ok {
			return d
		}
		select {
		case <-f.ch:
		case <-deadline:
			t.Fatalf("等待 %s 超时", id)
		}
	}
}

func TestRunner(t *testing.T) {
	s := newSigner(t)
	dir := t.TempDir()
	logFile := filepath.Join(dir, "app.log")
	var lines []string
	for i := 0; i < 300; i++ {
		lines = append(lines, "2026-10-24 10:00:00 INFO line "+string(rune('a'+i%26)))
	}
	lines = append(lines, "2026-10-24 10:00:01 ERROR db timeout")
	if err := os.WriteFile(logFile, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "secret"), filepath.Join(dir, "link.log")); err != nil {
		t.Fatal(err)
	}

	fs := &fakeSender{done: map[string]protocol.CmdDonePayload{}, output: map[string]string{}, ch: make(chan string, 100)}
	sleepTpl := protocol.CommandTemplate{Name: "custom.sleep", Risk: "read", TimeoutSeconds: 1}
	echoMax := 20.0
	echoTpl := protocol.CommandTemplate{Name: "custom.echo", Risk: "read", TimeoutSeconds: 5, Params: []protocol.CommandParam{{Name: "n", Type: "int", Required: true, Max: &echoMax}}}
	r := NewRunner(NewVerifier(s.pub, "host-1", t.TempDir()), Options{
		LogGlobs: []string{filepath.Join(dir, "*.log")},
		Custom:   []Custom{{Template: sleepTpl, Exec: []string{"/bin/sleep", "5"}}, {Template: echoTpl, Exec: []string{"/bin/echo", "n={n};$(id)"}}},
	}, fs, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()

	r.Handle(ctx, s.run(cmd("tail", "log.tail", map[string]string{"source": logFile, "n": "2"})))
	if d := fs.wait(t, "tail"); d.Status != "succeeded" || !strings.HasSuffix(d.Output, "ERROR db timeout\n") || strings.Count(d.Output, "\n") != 2 {
		t.Errorf("log.tail：%+v", d)
	}

	r.Handle(ctx, s.run(cmd("grep", "log.grep", map[string]string{"source": logFile, "pattern": "ERROR", "since": "7d"})))
	if d := fs.wait(t, "grep"); d.Status != "succeeded" || !strings.Contains(d.Output, "db timeout") {
		t.Errorf("log.grep：%+v", d)
	}

	// 配置范围外的文件、指向范围外的符号链接
	for id, src := range map[string]string{"outside": "/etc/hostname", "symlink": filepath.Join(dir, "link.log")} {
		r.Handle(ctx, s.run(cmd(id, "log.tail", map[string]string{"source": src})))
		if d := fs.wait(t, id); d.Status != "failed" {
			t.Errorf("%s：应失败，得到 %+v", id, d)
		}
	}

	// 写操作默认不允许
	r.Handle(ctx, s.run(cmd("restart", "svc.restart", map[string]string{"unit": "nginx"})))
	if d := fs.wait(t, "restart"); d.Status != "rejected" || !strings.Contains(d.Error, "commands.allow") {
		t.Errorf("svc.restart：%+v", d)
	}

	// 自定义指令：参数整体替换，不经过 shell
	r.Handle(ctx, s.run(cmd("echo", "custom.echo", map[string]string{"n": "7"})))
	if d := fs.wait(t, "echo"); d.Status != "succeeded" || d.Output != "n=7;$(id)\n" || d.ExitCode == nil || *d.ExitCode != 0 {
		t.Errorf("custom.echo：%+v", d)
	}
	r.Handle(ctx, s.run(cmd("echo-bad", "custom.echo", map[string]string{"n": "99"})))
	if d := fs.wait(t, "echo-bad"); d.Status != "rejected" {
		t.Errorf("参数超范围应拒绝：%+v", d)
	}

	// 超时中断
	start := time.Now()
	r.Handle(ctx, s.run(cmd("sleep", "custom.sleep", nil)))
	if d := fs.wait(t, "sleep"); d.Status != "timeout" || time.Since(start) > 3*time.Second {
		t.Errorf("custom.sleep：%+v", d)
	}

	// 取消
	slow := cmd("cancel", "custom.sleep", nil)
	r.Handle(ctx, s.run(slow))
	time.Sleep(100 * time.Millisecond)
	r.Cancel("cancel")
	if d := fs.wait(t, "cancel"); d.Status != "canceled" {
		t.Errorf("取消：%+v", d)
	}

	r.Handle(ctx, s.run(cmd("net", "net.conns", nil)))
	if d := fs.wait(t, "net"); d.Status != "succeeded" || !strings.Contains(d.Output, "连接数") {
		t.Errorf("net.conns：%+v", d)
	}
	r.Handle(ctx, s.run(cmd("du", "disk.usage", map[string]string{"path": dir})))
	if d := fs.wait(t, "du"); d.Status != "succeeded" || !strings.Contains(d.Output, "app.log") {
		t.Errorf("disk.usage：%+v", d)
	}
	r.Handle(ctx, s.run(cmd("top", "proc.top", map[string]string{"n": "3"})))
	if d := fs.wait(t, "top"); d.Status != "succeeded" || !strings.HasPrefix(d.Output, "PID") {
		t.Errorf("proc.top：%+v", d)
	}
	r.Handle(ctx, s.run(cmd("self", "proc.inspect", map[string]string{"pid": "1"})))
	if d := fs.wait(t, "self"); d.Status != "succeeded" || !strings.Contains(d.Output, "Threads") {
		t.Errorf("proc.inspect：%+v", d)
	}
}

func TestOutputLimit(t *testing.T) {
	var chunks []string
	var mu sync.Mutex
	o := newOutput(func(s string) { mu.Lock(); chunks = append(chunks, s); mu.Unlock() })
	o.WriteString(strings.Repeat("中", OutputLimit/3+10))
	text, truncated := o.Close()
	if !truncated || len(text) > OutputLimit+3 {
		t.Fatalf("截断：truncated=%v len=%d", truncated, len(text))
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(strings.Join(chunks, ""), "��") {
		t.Error("分片切断了多字节字符")
	}
}

func TestParseHexAddr(t *testing.T) {
	ip, port := parseHexAddr("0100007F:1F90")
	if ip != "127.0.0.1" || port != 8080 {
		t.Errorf("IPv4：%s %d", ip, port)
	}
	ip, _ = parseHexAddr("00000000000000000000000001000000:0016")
	if ip != "::1" {
		t.Errorf("IPv6：%s", ip)
	}
}
