// Package aggregate 把窗口内的多次采样聚合成 min / max / avg / p95。
package aggregate

import (
	"math"
	"sort"
	"sync"

	"pulse/agent/internal/protocol"
)

type key struct{ name, tag string }

type Window struct {
	mu      sync.Mutex
	samples map[key][]float64
	order   []key
}

func NewWindow() *Window {
	return &Window{samples: map[key][]float64{}}
}

func (w *Window) Add(name, tag string, v float64) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	k := key{name, tag}
	if _, ok := w.samples[k]; !ok {
		w.order = append(w.order, k)
	}
	w.samples[k] = append(w.samples[k], v)
}

// Snapshot 返回当前窗口的聚合结果，不清空窗口（用于提前推送）。
func (w *Window) Snapshot() []protocol.MetricPoint {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.points()
}

// Flush 返回聚合结果并清空窗口。
func (w *Window) Flush() []protocol.MetricPoint {
	w.mu.Lock()
	defer w.mu.Unlock()
	pts := w.points()
	w.samples = map[key][]float64{}
	w.order = nil
	return pts
}

func (w *Window) points() []protocol.MetricPoint {
	out := make([]protocol.MetricPoint, 0, len(w.order))
	for _, k := range w.order {
		out = append(out, Summarize(k.name, k.tag, w.samples[k]))
	}
	return out
}

// Summarize 计算一组采样值的统计量。p95 使用最近秩法。
func Summarize(name, tag string, values []float64) protocol.MetricPoint {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	n := len(sorted)
	idx := int(math.Ceil(0.95*float64(n))) - 1
	if idx < 0 {
		idx = 0
	}
	return protocol.MetricPoint{
		Name: name,
		Tag:  tag,
		Min:  round(sorted[0]),
		Max:  round(sorted[n-1]),
		Avg:  round(sum / float64(n)),
		P95:  round(sorted[idx]),
	}
}

func round(v float64) float64 { return math.Round(v*100) / 100 }
