package collect

import (
	"context"
	"net"
	"runtime"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"

	"pulse/agent/internal/protocol"
)

func HostInfo(ctx context.Context, labels map[string]string) protocol.HostInfo {
	info := protocol.HostInfo{Arch: runtime.GOARCH, Labels: labels, IPs: []string{}}
	if h, err := host.InfoWithContext(ctx); err == nil {
		info.Hostname = h.Hostname
		info.OS = h.OS
		info.Platform = h.Platform
		info.PlatformVersion = h.PlatformVersion
		info.Kernel = h.KernelVersion
		info.BootTime = int64(h.BootTime) * 1000
	}
	if n, err := cpu.CountsWithContext(ctx, true); err == nil {
		info.CPUCores = n
	}
	if ci, err := cpu.InfoWithContext(ctx); err == nil && len(ci) > 0 {
		info.CPUModel = ci[0].ModelName
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemTotal = vm.Total
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() {
				continue
			}
			info.IPs = append(info.IPs, ipnet.IP.String())
		}
	}
	if info.Hostname == "" {
		info.Hostname = "unknown"
	}
	return info
}
