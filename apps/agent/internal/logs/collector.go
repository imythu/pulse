package logs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"pulse/agent/internal/fingerprint"
	"pulse/agent/internal/protocol"
)

const (
	// WindowSeconds：同一指纹在一个窗口内只发首条完整样本，其余只累加次数
	WindowSeconds      = 10
	maxEventsPerWindow = 500
)

type source interface {
	run(ctx context.Context, cls *Classifier, emit func(Record), log *slog.Logger)
}

// Collector 运行所有日志源，并按 10 秒窗口把记录汇总成 LogEvent。
type Collector struct {
	sources []source
	cls     *Classifier
	log     *slog.Logger

	mu      sync.Mutex
	events  map[string]*protocol.LogEvent
	order   []string
	dropped int
}

func NewCollector(files []FileSource, journals []JournaldSource, keywords []string, log *slog.Logger) *Collector {
	c := &Collector{cls: NewClassifier(keywords), log: log, events: map[string]*protocol.LogEvent{}}
	for _, f := range files {
		c.sources = append(c.sources, f)
	}
	for _, j := range journals {
		c.sources = append(c.sources, j)
	}
	return c
}

// Run 阻塞运行，每个窗口结束时把汇总结果交给 send。
func (c *Collector) Run(ctx context.Context, send func(protocol.LogsPayload)) {
	if len(c.sources) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, s := range c.sources {
		wg.Add(1)
		go func() { defer wg.Done(); s.run(ctx, c.cls, c.add, c.log) }()
	}
	ticker := time.NewTicker(WindowSeconds * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-ticker.C:
			if p, ok := c.Flush(); ok {
				send(p)
			}
		}
	}
}

func (c *Collector) add(r Record) {
	tmpl := fingerprint.Template(r.Text)
	fp := fingerprint.Of(r.Service, r.Level, tmpl)
	ts := r.Time.UnixMilli()

	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.events[fp]; ok {
		e.Count++
		e.LastTs = ts
		return
	}
	if len(c.order) >= maxEventsPerWindow {
		c.dropped++
		return
	}
	c.events[fp] = &protocol.LogEvent{
		Fingerprint: fp, Service: r.Service, Level: r.Level, Source: r.Source,
		Message: r.Text, Context: r.Context, Count: 1, FirstTs: ts, LastTs: ts,
	}
	c.order = append(c.order, fp)
}

// Flush 取出当前窗口的汇总并开始新窗口。
func (c *Collector) Flush() (protocol.LogsPayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.order) == 0 && c.dropped == 0 {
		return protocol.LogsPayload{}, false
	}
	p := protocol.LogsPayload{RulesVersion: fingerprint.Version, Dropped: c.dropped, Events: make([]protocol.LogEvent, 0, len(c.order))}
	for _, fp := range c.order {
		p.Events = append(p.Events, *c.events[fp])
	}
	c.events, c.order, c.dropped = map[string]*protocol.LogEvent{}, nil, 0
	return p, true
}
