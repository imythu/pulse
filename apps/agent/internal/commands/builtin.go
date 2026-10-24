package commands

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"pulse/agent/internal/collect"
)

// 需要调用外部命令的模板，结果里带退出码
func usesExec(name string) bool {
	switch name {
	case "svc.status", "svc.restart", "docker.ps", "docker.logs":
		return true
	}
	return false
}

func (r *Runner) runBuiltin(ctx context.Context, name string, args map[string]string, out *Output) (int, error) {
	n, _ := strconv.Atoi(args["n"])
	switch name {
	case "proc.top":
		return 0, procTop(ctx, args["by"], n, out)
	case "proc.inspect":
		pid, _ := strconv.Atoi(args["pid"])
		return 0, procInspect(pid, out)
	case "log.tail":
		if unit, ok := strings.CutPrefix(args["source"], "journald:"); ok {
			if !r.opts.Journald {
				return -1, errors.New("本机未启用 journald 日志采集")
			}
			return runExec(ctx, out, "journalctl", "-u", unit, "-n", strconv.Itoa(n), "--no-pager", "-o", "short-iso")
		}
		path, err := r.logPath(args["source"])
		if err != nil {
			return -1, err
		}
		return 0, tailFile(path, n, out)
	case "log.grep":
		re, err := regexp.Compile(args["pattern"])
		if err != nil {
			return -1, fmt.Errorf("正则无效：%w", err)
		}
		secs, _ := ParseDuration(args["since"])
		since := time.Now().Add(-time.Duration(secs) * time.Second)
		if unit, ok := strings.CutPrefix(args["source"], "journald:"); ok {
			if !r.opts.Journald {
				return -1, errors.New("本机未启用 journald 日志采集")
			}
			buf := &Output{}
			code, err := runExec(ctx, buf, "journalctl", "-u", unit, "--since", since.Format("2006-01-02 15:04:05"), "--no-pager", "-o", "short-iso")
			if err != nil || code != 0 {
				out.WriteString(string(buf.buf))
				return code, err
			}
			return 0, grepLines(bytes.NewReader(buf.buf), re, time.Time{}, out)
		}
		path, err := r.logPath(args["source"])
		if err != nil {
			return -1, err
		}
		return 0, grepFile(path, re, since, out)
	case "net.conns":
		return 0, netConns(out)
	case "disk.usage":
		depth, _ := strconv.Atoi(args["depth"])
		return 0, diskUsage(ctx, args["path"], depth, out)
	case "svc.status":
		code, err := runExec(ctx, out, "systemctl", "status", args["unit"], "--no-pager", "--lines=20")
		// 3 = inactive、4 = 不存在：都是有效的查询结果
		if code > 0 && code <= 4 {
			return 0, err
		}
		return code, err
	case "svc.restart":
		code, err := runExec(ctx, out, "systemctl", "restart", args["unit"])
		if err != nil || code != 0 {
			return code, err
		}
		out.WriteString("\n$ systemctl is-active " + args["unit"] + "\n")
		return runExec(ctx, out, "systemctl", "is-active", args["unit"])
	case "docker.ps":
		return runExec(ctx, out, "docker", "ps", "-a", "--format", "table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")
	case "docker.logs":
		return runExec(ctx, out, "docker", "logs", "--tail", strconv.Itoa(n), "--timestamps", args["id"])
	}
	return -1, fmt.Errorf("模板 %s 没有实现", name)
}

// logPath 只允许读取日志采集配置里的文件（以及 commands.log_paths），符号链接解析后也必须在范围内。
func (r *Runner) logPath(p string) (string, error) {
	clean := filepath.Clean(p)
	match := func(s string) bool {
		for _, g := range r.opts.LogGlobs {
			if ok, _ := filepath.Match(g, s); ok {
				return true
			}
		}
		return false
	}
	if !match(clean) {
		return "", fmt.Errorf("%s 不在本机允许读取的日志文件范围内（logs.files 或 commands.log_paths）", clean)
	}
	real, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	if real != clean && !match(real) {
		return "", fmt.Errorf("%s 指向范围外的文件 %s", clean, real)
	}
	return real, nil
}

func procTop(ctx context.Context, by string, n int, out *Output) error {
	p := collect.NewProcs()
	p.Top(ctx, n) // 第一次采样建立 CPU 基线
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Second):
	}
	res := p.Top(ctx, n)
	list := res.ByCPU
	if by == "mem" {
		list = res.ByMem
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PID\tUSER\tCPU%\tMEM%\tRSS\tCOMMAND")
	for _, pr := range list {
		cmd := pr.Cmdline
		if cmd == "" {
			cmd = "[" + pr.Name + "]"
		}
		fmt.Fprintf(w, "%d\t%s\t%.1f\t%.1f\t%s\t%s\n", pr.PID, pr.User, pr.CPUPct, pr.MemPct, human(float64(pr.RSSBytes)), cmd)
	}
	return w.Flush()
}

func procInspect(pid int, out *Output) error {
	base := fmt.Sprintf("/proc/%d", pid)
	status, err := os.ReadFile(base + "/status")
	if err != nil {
		return fmt.Errorf("进程 %d 不存在或无权读取", pid)
	}
	cmdline, _ := os.ReadFile(base + "/cmdline")
	out.Printf("命令行：%s\n\n", strings.TrimSpace(strings.ReplaceAll(string(cmdline), "\x00", " ")))
	keep := map[string]bool{"Name": true, "State": true, "PPid": true, "Uid": true, "Threads": true, "VmPeak": true, "VmRSS": true, "VmSwap": true, "RssAnon": true, "RssFile": true, "voluntary_ctxt_switches": true, "nonvoluntary_ctxt_switches": true}
	for _, line := range strings.Split(string(status), "\n") {
		if k, _, ok := strings.Cut(line, ":"); ok && keep[k] {
			out.WriteString(line + "\n")
		}
	}
	if fds, err := os.ReadDir(base + "/fd"); err == nil {
		out.Printf("打开的文件描述符：%d\n", len(fds))
	} else {
		out.Printf("打开的文件描述符：无权读取（%v）\n", errors.Unwrap(err))
	}
	if limits, err := os.ReadFile(base + "/limits"); err == nil {
		for _, line := range strings.Split(string(limits), "\n") {
			if strings.HasPrefix(line, "Max open files") || strings.HasPrefix(line, "Max processes") {
				out.WriteString(strings.Join(strings.Fields(line), " ") + "\n")
			}
		}
	}
	if maps, err := os.ReadFile(base + "/maps"); err == nil {
		// 按映射的文件聚合，[heap]、[stack] 和匿名映射单独计
		size := map[string]uint64{}
		for _, line := range strings.Split(string(maps), "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			lo, hi, _ := strings.Cut(f[0], "-")
			a, _ := strconv.ParseUint(lo, 16, 64)
			b, _ := strconv.ParseUint(hi, 16, 64)
			name := "[anon]"
			if len(f) >= 6 {
				name = f[5]
			}
			size[name] += b - a
		}
		names := make([]string, 0, len(size))
		for k := range size {
			names = append(names, k)
		}
		sort.Slice(names, func(i, j int) bool { return size[names[i]] > size[names[j]] })
		out.WriteString("\n虚拟内存映射（前 15）：\n")
		for i, k := range names {
			if i == 15 {
				break
			}
			out.Printf("  %10s  %s\n", human(float64(size[k])), k)
		}
	}
	return nil
}

// tailFile 从文件末尾向前读，找到 n 行为止，最多读 8 MB。
func tailFile(path string, n int, out *Output) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	const chunk, maxRead = 64 << 10, 8 << 20
	end := st.Size()
	var buf []byte
	for end > 0 && bytes.Count(buf, []byte{'\n'}) <= n && int64(len(buf)) < maxRead {
		start := max(0, end-chunk)
		part := make([]byte, end-start)
		if _, err := f.ReadAt(part, start); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		buf = append(part, buf...)
		end = start
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	for _, l := range lines {
		out.WriteString(l + "\n")
	}
	return nil
}

const (
	grepMaxMatches = 500
	grepMaxScan    = 200 << 20
)

// 行首常见的时间格式；没有时间戳的行（堆栈等）沿用上一行的时间
var lineTimeRe = regexp.MustCompile(`^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})`)

func grepFile(path string, re *regexp.Regexp, since time.Time, out *Output) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > grepMaxScan {
		_, _ = f.Seek(st.Size()-grepMaxScan, io.SeekStart)
		out.Printf("（文件较大，只检索最后 %s）\n", human(grepMaxScan))
	}
	return grepLines(f, re, since, out)
}

func grepLines(r io.Reader, re *regexp.Regexp, since time.Time, out *Output) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	var matches []string
	total := 0
	inRange := since.IsZero()
	for sc.Scan() {
		line := sc.Text()
		if m := lineTimeRe.FindStringSubmatch(line); m != nil && !since.IsZero() {
			if t, err := time.ParseInLocation("2006-01-02 15:04:05", strings.Replace(m[1], "T", " ", 1), time.Local); err == nil {
				inRange = !t.Before(since)
			}
		}
		if inRange && re.MatchString(line) {
			total++
			matches = append(matches, line)
			if len(matches) > grepMaxMatches {
				matches = matches[1:]
			}
		}
	}
	for _, m := range matches {
		out.WriteString(m + "\n")
	}
	if total > len(matches) {
		out.Printf("\n共匹配 %d 行，只显示最后 %d 行\n", total, len(matches))
	} else if total == 0 {
		out.WriteString("没有匹配的行\n")
	}
	return sc.Err()
}

var tcpStates = map[string]string{
	"01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT",
	"07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING",
}

func netConns(out *Output) error {
	states := map[string]int{}
	remotes := map[string]int{}
	listen := map[string]bool{}
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for i, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if i == 0 || len(f) < 4 {
				continue
			}
			st := tcpStates[f[3]]
			states[st]++
			switch st {
			case "ESTABLISHED", "TIME_WAIT", "CLOSE_WAIT", "SYN_SENT":
				ip, _ := parseHexAddr(f[2])
				remotes[ip+" "+st]++
			case "LISTEN":
				ip, port := parseHexAddr(f[1])
				listen[net.JoinHostPort(ip, strconv.Itoa(port))] = true
			}
		}
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "状态\t连接数")
	for _, k := range sortedByCount(states, 20) {
		fmt.Fprintf(w, "%s\t%d\n", k, states[k])
	}
	fmt.Fprintln(w, "\n远端地址\t状态\t连接数")
	for _, k := range sortedByCount(remotes, 20) {
		ip, st, _ := strings.Cut(k, " ")
		fmt.Fprintf(w, "%s\t%s\t%d\n", ip, st, remotes[k])
	}
	_ = w.Flush()
	ports := make([]string, 0, len(listen))
	for k := range listen {
		ports = append(ports, k)
	}
	sort.Strings(ports)
	out.Printf("\n监听：%s\n", strings.Join(ports, "  "))
	return nil
}

func sortedByCount(m map[string]int, n int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return m[keys[i]] > m[keys[j]] || (m[keys[i]] == m[keys[j]] && keys[i] < keys[j]) })
	if len(keys) > n {
		keys = keys[:n]
	}
	return keys
}

// parseHexAddr 解析 /proc/net/tcp 的 "0100007F:1F90"（IPv4 按 32 位小端，IPv6 按 4 组 32 位小端）。
func parseHexAddr(s string) (string, int) {
	h, p, _ := strings.Cut(s, ":")
	port, _ := strconv.ParseInt(p, 16, 32)
	raw := make([]byte, len(h)/2)
	for i := range raw {
		b, _ := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
		raw[i] = byte(b)
	}
	for i := 0; i+4 <= len(raw); i += 4 {
		raw[i], raw[i+1], raw[i+2], raw[i+3] = raw[i+3], raw[i+2], raw[i+1], raw[i]
	}
	ip := net.IP(raw)
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return ip.String(), int(port)
}

const diskUsageBudget = 25 * time.Second

// diskUsage 统计 path 下各子目录（到 depth 层）的大小，不跨文件系统，最多耗时 25 秒。
func diskUsage(ctx context.Context, root string, depth int, out *Output) error {
	root = filepath.Clean(root)
	st, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s 不是目录", root)
	}
	dev := st.Sys().(*syscall.Stat_t).Dev
	deadline := time.Now().Add(diskUsageBudget)
	sizes := map[string]int64{}
	var total int64
	partial := false
	errCount := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			errCount++
			return nil
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			partial = true
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if d.IsDir() && p != root {
			if s, ok := info.Sys().(*syscall.Stat_t); ok && s.Dev != dev {
				return filepath.SkipDir
			}
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		blocks := info.Size()
		if s, ok := info.Sys().(*syscall.Stat_t); ok {
			blocks = s.Blocks * 512
		}
		total += blocks
		rel, _ := filepath.Rel(root, p)
		parts := strings.Split(rel, string(filepath.Separator))
		for i := 1; i <= depth && i < len(parts); i++ {
			sizes[filepath.Join(parts[:i]...)] += blocks
		}
		if len(parts) == 1 {
			sizes[parts[0]] += blocks
		}
		return nil
	})
	keys := make([]string, 0, len(sizes))
	for k := range sizes {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return sizes[keys[i]] > sizes[keys[j]] })
	if len(keys) > 30 {
		keys = keys[:30]
	}
	out.Printf("%s 合计 %s\n\n", root, human(float64(total)))
	for _, k := range keys {
		out.Printf("%10s  %s\n", human(float64(sizes[k])), filepath.Join(root, k))
	}
	if partial {
		out.WriteString("\n（超过 25 秒，结果不完整）\n")
	}
	if errCount > 0 {
		out.Printf("\n（%d 个目录无权读取，未计入）\n", errCount)
	}
	return nil
}

func human(b float64) string {
	units := []string{"B", "K", "M", "G", "T"}
	i := 0
	for b >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f%s", b, units[i])
	}
	return fmt.Sprintf("%.1f%s", b, units[i])
}
