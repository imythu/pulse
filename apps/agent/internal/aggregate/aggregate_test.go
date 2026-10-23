package aggregate

import "testing"

func TestSummarize(t *testing.T) {
	vals := make([]float64, 0, 20)
	for i := 1; i <= 20; i++ {
		vals = append(vals, float64(i))
	}
	p := Summarize("cpu.usage_pct", "", vals)
	if p.Min != 1 || p.Max != 20 || p.Avg != 10.5 || p.P95 != 19 {
		t.Fatalf("unexpected %+v", p)
	}
}

func TestWindowFlushKeepsOrderAndResets(t *testing.T) {
	w := NewWindow()
	w.Add("b", "", 1)
	w.Add("a", "/", 2)
	w.Add("b", "", 3)
	pts := w.Flush()
	if len(pts) != 2 || pts[0].Name != "b" || pts[0].Avg != 2 || pts[1].Tag != "/" {
		t.Fatalf("unexpected %+v", pts)
	}
	if len(w.Flush()) != 0 {
		t.Fatal("window not reset")
	}
}
