// Package collect 采集主机指标、进程和主机信息（设计文档 3.2）。
package collect

import (
	"bufio"
	"context"
	"os"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// 指标名，与 packages/shared/src/metrics.ts 一致
const (
	CPUUsage      = "cpu.usage_pct"
	CPUIowait     = "cpu.iowait_pct"
	Load1         = "load.1"
	Load5         = "load.5"
	Load15        = "load.15"
	MemUsed       = "mem.used_pct"
	MemUsedBytes  = "mem.used_bytes"
	SwapUsed      = "swap.used_pct"
	DiskUsed      = "disk.used_pct"
	DiskInodeUsed = "disk.inode_used_pct"
	DiskReadBps   = "disk.read_bps"
	DiskWriteBps  = "disk.write_bps"
	NetRxBps      = "net.rx_bps"
	NetTxBps      = "net.tx_bps"
	TCPEstab      = "net.tcp_established"
	TCPTimeWait   = "net.tcp_time_wait"
)

// Sample 是一次采样的结果，Tag 为空表示主机级别的值。
type Sample struct {
	Name  string
	Tag   string
	Value float64
}

// System 保存计算速率所需的上一次计数器值。
type System struct {
	ignoreFS map[string]bool
	prevCPU  *cpu.TimesStat
	prevDisk *ioCounters
	prevNet  *ioCounters
}

type ioCounters struct {
	at      time.Time
	in, out uint64
}

func NewSystem(ignoreFSTypes []string) *System {
	ignore := map[string]bool{}
	for _, t := range ignoreFSTypes {
		ignore[t] = true
	}
	return &System{ignoreFS: ignore}
}

// Collect 采集一次。withDisk 为 false 时跳过磁盘容量（它的采样间隔更长）。
// 速率类指标在第一次调用时没有基线，不会输出。
func (s *System) Collect(ctx context.Context, withDisk bool) []Sample {
	var out []Sample
	add := func(name, tag string, v float64) { out = append(out, Sample{name, tag, v}) }

	if times, err := cpu.TimesWithContext(ctx, false); err == nil && len(times) > 0 {
		cur := times[0]
		if s.prevCPU != nil {
			usage, iowait := cpuPercent(*s.prevCPU, cur)
			add(CPUUsage, "", usage)
			add(CPUIowait, "", iowait)
		}
		s.prevCPU = &cur
	}

	if l, err := load.AvgWithContext(ctx); err == nil {
		add(Load1, "", l.Load1)
		add(Load5, "", l.Load5)
		add(Load15, "", l.Load15)
	}

	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil && vm.Total > 0 {
		// 以 available 计算已用，和 free -h 的 available 列一致，不把可回收缓存算作占用
		used := vm.Total - vm.Available
		add(MemUsed, "", float64(used)/float64(vm.Total)*100)
		add(MemUsedBytes, "", float64(used))
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil && sw.Total > 0 {
		add(SwapUsed, "", sw.UsedPercent)
	}

	if withDisk {
		for _, u := range s.diskUsage(ctx) {
			out = append(out, u...)
		}
	}

	now := time.Now()
	if r, w, ok := diskIO(ctx); ok {
		cur := &ioCounters{at: now, in: r, out: w}
		if rin, rout, ok := rate(s.prevDisk, cur); ok {
			add(DiskReadBps, "", rin)
			add(DiskWriteBps, "", rout)
		}
		s.prevDisk = cur
	}
	if rx, tx, ok := netIO(ctx); ok {
		cur := &ioCounters{at: now, in: rx, out: tx}
		if rin, rout, ok := rate(s.prevNet, cur); ok {
			add(NetRxBps, "", rin)
			add(NetTxBps, "", rout)
		}
		s.prevNet = cur
	}

	if estab, tw, ok := tcpStates(); ok {
		add(TCPEstab, "", float64(estab))
		add(TCPTimeWait, "", float64(tw))
	}
	return out
}

func cpuPercent(prev, cur cpu.TimesStat) (usage, iowait float64) {
	busy := func(t cpu.TimesStat) float64 {
		return t.User + t.Nice + t.System + t.Irq + t.Softirq + t.Steal
	}
	total := func(t cpu.TimesStat) float64 { return busy(t) + t.Idle + t.Iowait }
	dt := total(cur) - total(prev)
	if dt <= 0 {
		return 0, 0
	}
	return clampPct((busy(cur) - busy(prev)) / dt * 100), clampPct((cur.Iowait - prev.Iowait) / dt * 100)
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func rate(prev, cur *ioCounters) (in, out float64, ok bool) {
	if prev == nil {
		return 0, 0, false
	}
	dt := cur.at.Sub(prev.at).Seconds()
	// 计数器回绕或重置（如网卡重建）时跳过这一次
	if dt <= 0 || cur.in < prev.in || cur.out < prev.out {
		return 0, 0, false
	}
	return float64(cur.in-prev.in) / dt, float64(cur.out-prev.out) / dt, true
}

func (s *System) diskUsage(ctx context.Context) [][]Sample {
	// all=true：gopsutil 的 all=false 会过滤掉 overlay 等 nodev 文件系统，容器根分区就丢了。
	// 伪文件系统由 ignoreFS 过滤。
	parts, err := disk.PartitionsWithContext(ctx, true)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out [][]Sample
	for _, p := range parts {
		// 根分区总是采集：容器里的 Agent 根分区是 overlay，但它写满同样会出问题
		ignored := s.ignoreFS[p.Fstype] && p.Mountpoint != "/"
		if ignored || seen[p.Device] || strings.HasPrefix(p.Mountpoint, "/snap/") {
			continue
		}
		// 容器里 /etc/hostname 这类单文件绑定挂载不是磁盘
		if fi, err := os.Stat(p.Mountpoint); err != nil || !fi.IsDir() {
			continue
		}
		seen[p.Device] = true
		u, err := disk.UsageWithContext(ctx, p.Mountpoint)
		if err != nil || u.Total == 0 {
			continue
		}
		samples := []Sample{{DiskUsed, p.Mountpoint, u.UsedPercent}}
		if u.InodesTotal > 0 {
			samples = append(samples, Sample{DiskInodeUsed, p.Mountpoint, u.InodesUsedPercent})
		}
		out = append(out, samples)
	}
	return out
}

// diskIO 只统计 /sys/block 下的物理盘，避免分区、LVM、软 RAID 重复计数。
func diskIO(ctx context.Context) (read, write uint64, ok bool) {
	counters, err := disk.IOCountersWithContext(ctx)
	if err != nil {
		return 0, 0, false
	}
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return 0, 0, false
	}
	for _, e := range entries {
		name := e.Name()
		if hasAnyPrefix(name, "loop", "ram", "zram", "dm-", "md", "sr", "fd") {
			continue
		}
		if c, found := counters[name]; found {
			read += c.ReadBytes
			write += c.WriteBytes
		}
	}
	return read, write, true
}

func netIO(ctx context.Context) (rx, tx uint64, ok bool) {
	counters, err := net.IOCountersWithContext(ctx, true)
	if err != nil {
		return 0, 0, false
	}
	for _, c := range counters {
		if c.Name == "lo" || hasAnyPrefix(c.Name, "docker", "veth", "br-", "virbr", "cni", "flannel", "cali", "tun", "kube") {
			continue
		}
		rx += c.BytesRecv
		tx += c.BytesSent
	}
	return rx, tx, true
}

// tcpStates 读 /proc/net/tcp{,6} 的状态列：01 = ESTABLISHED，06 = TIME_WAIT。
func tcpStates() (estab, timeWait int, ok bool) {
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		ok = true
		sc := bufio.NewScanner(f)
		sc.Scan() // 表头
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			if len(fields) < 4 {
				continue
			}
			switch fields[3] {
			case "01":
				estab++
			case "06":
				timeWait++
			}
		}
		f.Close()
	}
	return estab, timeWait, ok
}

func hasAnyPrefix(s string, prefixes ...string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
