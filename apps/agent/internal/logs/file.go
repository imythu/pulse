package logs

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const (
	pollInterval   = time.Second
	rescanInterval = 10 * time.Second
	idleFlush      = 2 * time.Second
	maxReadPerPoll = 1 << 20
)

// FileSource 跟踪一组 glob 匹配的日志文件，处理轮转（inode 变化）和截断。
type FileSource struct {
	Service string
	Paths   []string
	// Format: auto（默认，JSON 行按结构化日志解析）、plain、json、docker（json-file 日志驱动）
	Format string
}

type tailedFile struct {
	path    string
	f       *os.File
	ino     uint64
	off     int64
	partial []byte
	asm     *assembler
}

func inode(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}

func (s FileSource) run(ctx context.Context, cls *Classifier, emit func(Record), log *slog.Logger) {
	files := map[string]*tailedFile{}
	defer func() {
		for _, t := range files {
			t.f.Close()
		}
	}()

	// 启动时已存在的文件从末尾开始读，不补报历史日志；之后新出现的文件从头读
	s.rescan(files, cls, emit, true, log)
	lastScan := time.Now()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if now.Sub(lastScan) >= rescanInterval {
				s.rescan(files, cls, emit, false, log)
				lastScan = now
			}
			for path, t := range files {
				if !s.poll(t, now) {
					t.f.Close()
					delete(files, path)
				}
				t.asm.FlushIdle(now, idleFlush)
			}
		}
	}
}

func (s FileSource) rescan(files map[string]*tailedFile, cls *Classifier, emit func(Record), initial bool, log *slog.Logger) {
	for _, pattern := range s.Paths {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			log.Warn("日志路径格式错误", "pattern", pattern, "err", err)
			continue
		}
		for _, path := range matches {
			if _, ok := files[path]; ok {
				continue
			}
			t, err := openTail(path, initial)
			if err != nil {
				log.Warn("无法读取日志文件", "path", path, "err", err)
				continue
			}
			t.asm = newAssembler(s.Service, path, cls, emit)
			files[path] = t
		}
	}
}

func openTail(path string, fromEnd bool) (*tailedFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, os.ErrInvalid
	}
	t := &tailedFile{path: path, f: f, ino: inode(fi)}
	if fromEnd {
		t.off = fi.Size()
	}
	return t, nil
}

// poll 读取新增内容。返回 false 表示文件已不存在，调用方应停止跟踪。
func (s FileSource) poll(t *tailedFile, now time.Time) bool {
	fi, err := os.Stat(t.path)
	if err != nil {
		s.read(t, now) // 读完已删除文件里剩下的内容
		return false
	}
	if ino := inode(fi); ino != t.ino {
		// 轮转：先读完旧文件，再从头读新文件
		s.read(t, now)
		t.f.Close()
		f, err := os.Open(t.path)
		if err != nil {
			return false
		}
		t.f, t.ino, t.off, t.partial = f, ino, 0, nil
	} else if fi.Size() < t.off {
		t.off, t.partial = 0, nil // copytruncate 方式的轮转
	}
	s.read(t, now)
	return true
}

func (s FileSource) read(t *tailedFile, now time.Time) {
	buf := make([]byte, 64<<10)
	for total := 0; total < maxReadPerPoll; {
		n, err := t.f.ReadAt(buf, t.off)
		if n > 0 {
			t.off += int64(n)
			total += n
			s.consume(t, buf[:n], now)
		}
		if err == io.EOF || n == 0 || err != nil {
			return
		}
	}
}

func (s FileSource) consume(t *tailedFile, chunk []byte, now time.Time) {
	data := chunk
	if len(t.partial) > 0 {
		data = append(t.partial, chunk...)
		t.partial = nil
	}
	for {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			// 不完整的行留到下次；超长的行直接截断处理，避免无限占用内存
			if len(data) > maxLineBytes {
				s.line(t, string(data[:maxLineBytes]), now)
			} else if len(data) > 0 {
				t.partial = append([]byte(nil), data...)
			}
			return
		}
		s.line(t, string(bytes.TrimRight(data[:i], "\r")), now)
		data = data[i+1:]
	}
}

func (s FileSource) line(t *tailedFile, line string, now time.Time) {
	if s.Format == "docker" {
		line, _ = unwrapDocker(line)
	}
	if s.Format != "plain" {
		if text, level, ok := t.asm.cls.ParseJSON(line); ok {
			t.asm.FeedRecord(text, level, now)
			return
		}
	}
	t.asm.Feed(line, now)
}
