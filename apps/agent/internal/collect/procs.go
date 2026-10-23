package collect

import (
	"context"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"pulse/agent/internal/protocol"
)

const maxCmdline = 512

// Procs 计算进程 CPU 占用需要两次采样的差值，所以保存上一次每个进程的 CPU 时间。
type Procs struct {
	prev   map[int32]procTimes
	prevAt time.Time
}

type procTimes struct {
	cpu        float64
	createTime int64
}

func NewProcs() *Procs {
	return &Procs{prev: map[int32]procTimes{}}
}

// Top 返回按 CPU 和按内存排序的前 n 个进程。CPU 百分比按单核计，与 top 一致。
// 第一次调用没有基线，CPU 占用全部为 0。
func (p *Procs) Top(ctx context.Context, n int) protocol.ProcsPayload {
	now := time.Now()
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return protocol.ProcsPayload{}
	}
	dt := now.Sub(p.prevAt).Seconds()
	cur := make(map[int32]procTimes, len(procs))
	type entry struct {
		proc *process.Process
		info protocol.ProcessInfo
	}
	all := make([]entry, 0, len(procs))
	for _, pr := range procs {
		t, err := pr.TimesWithContext(ctx)
		if err != nil {
			continue
		}
		ct, _ := pr.CreateTimeWithContext(ctx)
		total := t.User + t.System
		cur[pr.Pid] = procTimes{cpu: total, createTime: ct}
		info := protocol.ProcessInfo{PID: pr.Pid}
		// pid 被复用时 createTime 会变，不能和旧值相减
		if prev, ok := p.prev[pr.Pid]; ok && prev.createTime == ct && dt > 0 {
			info.CPUPct = round2((total - prev.cpu) / dt * 100)
		}
		if mp, err := pr.MemoryPercentWithContext(ctx); err == nil {
			info.MemPct = round2(float64(mp))
		}
		if mi, err := pr.MemoryInfoWithContext(ctx); err == nil {
			info.RSSBytes = mi.RSS
		}
		all = append(all, entry{pr, info})
	}
	p.prev, p.prevAt = cur, now

	// 名称、命令行、用户只给入选的进程取，减少 /proc 读取
	fill := func(e entry) protocol.ProcessInfo {
		info := e.info
		info.Name, _ = e.proc.NameWithContext(ctx)
		info.User, _ = e.proc.UsernameWithContext(ctx)
		cmd, _ := e.proc.CmdlineWithContext(ctx)
		if len(cmd) > maxCmdline {
			cmd = cmd[:maxCmdline]
		}
		info.Cmdline = cmd
		return info
	}
	pick := func(less func(a, b protocol.ProcessInfo) bool) []protocol.ProcessInfo {
		sort.SliceStable(all, func(i, j int) bool { return less(all[i].info, all[j].info) })
		out := make([]protocol.ProcessInfo, 0, n)
		for i := 0; i < len(all) && i < n; i++ {
			out = append(out, fill(all[i]))
		}
		return out
	}
	return protocol.ProcsPayload{
		ByCPU: pick(func(a, b protocol.ProcessInfo) bool { return a.CPUPct > b.CPUPct }),
		ByMem: pick(func(a, b protocol.ProcessInfo) bool { return a.RSSBytes > b.RSSBytes }),
	}
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
