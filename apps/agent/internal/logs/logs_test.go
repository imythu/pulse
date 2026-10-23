package logs

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	c := NewClassifier(nil)
	cases := []struct {
		line, level string
	}{
		{"2026-10-23 10:00:00 ERROR [main] boom", LevelError},
		{"2026/10/23 10:00:00 [error] 12#0: *1 upstream timed out", LevelError},
		{"level=fatal msg=\"db gone\"", LevelFatal},
		{"INFO request timeout=30s configured", ""}, // 明确的 INFO 不按关键字判断
		{"WARN slow query", ""},
		{"Exception in thread \"main\" java.lang.IllegalStateException", LevelError},
		{"panic: runtime error: invalid memory address", LevelFatal},
		{"[12345.678] app[999]: segfault at 0 ip 000 sp 000 error 4", LevelFatal},
		{"GET /errors 200", ""},
	}
	for _, tc := range cases {
		if got, _ := c.Classify(tc.line); got != tc.level {
			t.Errorf("%q: got %q want %q", tc.line, got, tc.level)
		}
	}
}

func TestParseJSON(t *testing.T) {
	c := NewClassifier(nil)
	text, level, ok := c.ParseJSON(`{"level":50,"msg":"charge failed","err":{"message":"card declined","stack":"Error: card declined\n    at charge (/app/pay.js:3:9)"}}`)
	if !ok || level != LevelError || !strings.HasPrefix(text, "charge failed\nError: card declined") {
		t.Fatalf("got %q %q %v", text, level, ok)
	}
	if _, level, ok := c.ParseJSON(`{"level":"info","msg":"request timeout set"}`); !ok || level != "" {
		t.Fatalf("info 行不应上报，got %q", level)
	}
	if _, _, ok := c.ParseJSON("plain text"); ok {
		t.Fatal("非 JSON 行")
	}
}

func TestMask(t *testing.T) {
	in := `login failed for bob@example.com phone 13812345678 password=hunter2 Authorization: Bearer abc.def token: "s3cr3t" url=https://u:p@db:5432/x`
	out := Mask(in)
	for _, leaked := range []string{"bob@example.com", "13812345678", "hunter2", "abc.def", "s3cr3t", "u:p@"} {
		if strings.Contains(out, leaked) {
			t.Errorf("未打码 %q：%s", leaked, out)
		}
	}
	// 打码不能跨行吞掉堆栈
	if got := Mask("failed password=x1\njava.lang.IllegalStateException: boom"); got != "failed password=***\njava.lang.IllegalStateException: boom" {
		t.Errorf("跨行打码：%q", got)
	}
}

type sink struct {
	mu   sync.Mutex
	recs []Record
}

func (s *sink) emit(r Record) { s.mu.Lock(); s.recs = append(s.recs, r); s.mu.Unlock() }
func (s *sink) all() []Record { s.mu.Lock(); defer s.mu.Unlock(); return append([]Record(nil), s.recs...) }

func feedAll(a *assembler, text string) {
	now := time.Now()
	for _, l := range strings.Split(text, "\n") {
		a.Feed(l, now)
	}
	a.FlushIdle(now.Add(time.Minute), idleFlush)
}

func TestAssemblerMultiline(t *testing.T) {
	var s sink
	a := newAssembler("svc", "test", NewClassifier(nil), s.emit)
	feedAll(a, `2026-10-23 10:00:00 INFO starting
2026-10-23 10:00:01 INFO request ok
2026-10-23 10:00:02 ERROR c.e.Svc - Payment failed
java.lang.NullPointerException: boom
	at com.example.Svc.pay(Svc.java:10)
	... 3 more
2026-10-23 10:00:03 INFO next
ERROR:root:job crashed
Traceback (most recent call last):
  File "/srv/jobs.py", line 7, in run
    x = 1 / 0
ZeroDivisionError: division by zero
2026-10-23 10:00:04 INFO after python
panic: runtime error: index out of range

goroutine 1 [running]:
main.main()
	/app/main.go:5 +0x1d`)
	recs := s.all()
	if len(recs) != 3 {
		for _, r := range recs {
			t.Logf("%s: %q", r.Level, r.Text)
		}
		t.Fatalf("应合并成 3 条异常记录，实际 %d", len(recs))
	}
	if !strings.HasSuffix(recs[0].Text, "... 3 more") || len(recs[0].Context) != 2 {
		t.Errorf("Java 记录：%q context=%v", recs[0].Text, recs[0].Context)
	}
	if !strings.HasSuffix(recs[1].Text, "ZeroDivisionError: division by zero") {
		t.Errorf("Python 记录：%q", recs[1].Text)
	}
	if recs[2].Level != LevelFatal || !strings.Contains(recs[2].Text, "main.main()") {
		t.Errorf("Go panic 记录：%s %q", recs[2].Level, recs[2].Text)
	}
}

func TestFileSourceFollowsRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	write := func(flag int, s string) {
		f, err := os.OpenFile(path, flag|os.O_WRONLY|os.O_CREATE, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		f.WriteString(s)
		f.Close()
	}
	write(os.O_TRUNC, "2026-10-23 10:00:00 ERROR old error before start\n")

	var s sink
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	src := FileSource{Service: "app", Paths: []string{filepath.Join(dir, "*.log")}, Format: "auto"}
	go src.run(ctx, NewClassifier(nil), s.emit, slog.New(slog.NewTextHandler(io.Discard, nil)))
	time.Sleep(300 * time.Millisecond)

	write(os.O_APPEND, "2026-10-23 10:00:01 ERROR first\n")
	time.Sleep(1500 * time.Millisecond)
	// 轮转：旧文件改名，新建同名文件
	os.Rename(path, path+".1")
	write(os.O_TRUNC, `{"level":"error","msg":"second"}`+"\n")

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && len(s.all()) < 2 {
		time.Sleep(200 * time.Millisecond)
	}
	recs := s.all()
	if len(recs) != 2 || !strings.Contains(recs[0].Text, "first") || recs[1].Text != "second" {
		t.Fatalf("got %+v", recs)
	}
}

func TestCollectorWindow(t *testing.T) {
	c := NewCollector(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	now := time.Now()
	for i := 0; i < 1000; i++ {
		c.add(Record{Service: "api", Level: LevelError, Text: "ERROR order " + strings.Repeat("9", i%7+1) + " failed", Time: now})
	}
	c.add(Record{Service: "api", Level: LevelError, Text: "ERROR other", Time: now})
	p, ok := c.Flush()
	if !ok || len(p.Events) != 2 || p.Events[0].Count != 1000 || p.Events[0].Message != "ERROR order 9 failed" {
		t.Fatalf("got %+v", p.Events)
	}
	if _, ok := c.Flush(); ok {
		t.Fatal("新窗口应为空")
	}
}
