package collect

import (
	"context"
	"testing"
)

func TestCollectIncludesRootDisk(t *testing.T) {
	s := NewSystem([]string{"tmpfs", "overlay", "proc", "sysfs", "devpts", "cgroup2", "mqueue"})
	s.Collect(context.Background(), false)
	found := false
	for _, smp := range s.Collect(context.Background(), true) {
		if smp.Name == DiskUsed && smp.Tag == "/" {
			found = true
		}
		if smp.Name == DiskUsed && (smp.Tag == "/proc" || smp.Tag == "/dev" || smp.Tag == "/etc/hostname") {
			t.Fatalf("伪文件系统不应被采集：%s", smp.Tag)
		}
	}
	if !found {
		t.Fatal("没有采集到根分区")
	}
}
