package collect

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"pulse/agent/internal/config"
	"pulse/agent/internal/protocol"
)

var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// ServiceVersions 读取配置的服务当前部署的提交号（设计文档 7.3）：版本文件优先，其次容器镜像 label。
// 读不到或不像提交号的跳过，由服务器标注“版本未确认”。
func ServiceVersions(ctx context.Context, services []config.Service) []protocol.ServiceVersion {
	var out []protocol.ServiceVersion
	for _, s := range services {
		if s.VersionFile != "" {
			if v := firstLine(s.VersionFile); shaRe.MatchString(v) {
				out = append(out, protocol.ServiceVersion{Service: s.Name, Commit: strings.ToLower(v), Source: "file:" + s.VersionFile})
				continue
			}
		}
		if s.Container != "" {
			if v := containerRevision(ctx, s.Container); shaRe.MatchString(v) {
				out = append(out, protocol.ServiceVersion{Service: s.Name, Commit: strings.ToLower(v), Source: "container:" + s.Container})
			}
		}
	}
	return out
}

func firstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if sc.Scan() {
		return strings.TrimSpace(sc.Text())
	}
	return ""
}

func containerRevision(ctx context.Context, name string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "inspect", "--format", `{{index .Config.Labels "org.opencontainers.image.revision"}}`, name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
