package logs

import (
	"regexp"
	"strings"
	"time"
)

const (
	maxRecordLines = 200
	maxRecordBytes = 16 << 10
	maxLineBytes   = 4 << 10
	contextLines   = 20
	contextLineMax = 512
)

// Record 是一条完整的异常记录（可能包含多行堆栈）。
type Record struct {
	Service string
	Source  string
	Level   string
	Text    string
	Context []string
	Time    time.Time
}

var (
	// 行首是时间戳或级别词的行一定是新记录的开头
	recordStart  = regexp.MustCompile(`^(\[?[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}|\[?[0-9]{2}:[0-9]{2}:[0-9]{2}|[A-Z][a-z]{2} +[0-9]{1,2} [0-9]{2}:|\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b)`)
	continuation = regexp.MustCompile(`^(Caused by: |Suppressed: |\.\.\. [0-9]+ (more|common frames omitted)|Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause|goroutine [0-9]+ \[)`)
	// Java 的异常行不缩进，紧跟在日志头后面
	javaException = regexp.MustCompile(`^([a-zA-Z_$][a-zA-Z0-9_$]*\.)+[a-zA-Z0-9_$]*(Exception|Error|Throwable)(:|$)`)
)

type mode int

const (
	modeNormal mode = iota
	modeTraceback
	modeGoPanic
)

// assembler 把一个流（一个文件或一个 journald unit）的行合并成记录。
// 只有开头一行被判定为异常的记录才会保留全部内容，其余记录只用来维护上下文缓冲区。
type assembler struct {
	service, source string
	cls             *Classifier
	emit            func(Record)

	ring    []string // 最近的普通日志行，作为异常的上下文
	cur     *Record
	lines   []string
	size    int
	mode    mode
	lastAdd time.Time
}

func newAssembler(service, source string, cls *Classifier, emit func(Record)) *assembler {
	return &assembler{service: service, source: source, cls: cls, emit: emit}
}

func (a *assembler) isContinuation(line string) bool {
	if a.cur == nil && a.lines == nil {
		return false
	}
	if line == "" {
		return true // 空行不单独成为记录；Go panic 的栈中间也有空行
	}
	if line[0] == ' ' || line[0] == '\t' || continuation.MatchString(line) {
		return true
	}
	if recordStart.MatchString(line) {
		return false
	}
	return a.mode != modeNormal || javaException.MatchString(line)
}

// Feed 处理一行日志。
func (a *assembler) Feed(line string, now time.Time) {
	if len(line) > maxLineBytes {
		line = line[:maxLineBytes]
	}
	if a.isContinuation(line) {
		a.append(line, now)
		return
	}
	a.finish()
	level, _ := a.cls.Classify(line)
	if level != "" {
		a.cur = &Record{Service: a.service, Source: a.source, Level: level, Time: now, Context: a.context()}
	}
	a.lines = []string{}
	a.size = 0
	a.mode = modeNormal
	a.append(line, now)
}

func (a *assembler) append(line string, now time.Time) {
	a.lastAdd = now
	switch {
	case strings.HasPrefix(line, "Traceback (most recent call last):"):
		a.mode = modeTraceback
	case strings.HasPrefix(line, "panic: ") || strings.HasPrefix(line, "goroutine "):
		a.mode = modeGoPanic
	case a.mode == modeTraceback && line != "" && line[0] != ' ':
		// Python 堆栈最后一行是不缩进的异常类型，之后的行恢复正常判断
		if !continuation.MatchString(line) {
			a.mode = modeNormal
		}
	}
	a.remember(line)
	if a.cur == nil || len(a.lines) >= maxRecordLines || a.size+len(line) > maxRecordBytes {
		return
	}
	a.lines = append(a.lines, line)
	a.size += len(line) + 1
}

func (a *assembler) remember(line string) {
	if line == "" {
		return
	}
	if len(line) > contextLineMax {
		line = line[:contextLineMax]
	}
	if len(a.ring) == contextLines {
		copy(a.ring, a.ring[1:])
		a.ring = a.ring[:contextLines-1]
	}
	a.ring = append(a.ring, line)
}

func (a *assembler) context() []string {
	out := make([]string, len(a.ring))
	for i, l := range a.ring {
		out[i] = Mask(l)
	}
	return out
}

// FeedRecord 处理一条已经完整的记录（结构化日志、journald 消息），不参与多行合并。
func (a *assembler) FeedRecord(text, level string, now time.Time) {
	a.finish()
	a.lines, a.mode = nil, modeNormal
	if level != "" {
		a.emit(Record{Service: a.service, Source: a.source, Level: level, Text: Mask(text), Context: a.context(), Time: now})
	}
	for _, l := range strings.Split(text, "\n") {
		a.remember(l)
	}
}

// FlushIdle 在一段时间没有新行后结束当前记录，避免最后一条异常一直等不到下一行。
func (a *assembler) FlushIdle(now time.Time, idle time.Duration) {
	if a.lines != nil && now.Sub(a.lastAdd) >= idle {
		a.finish()
		a.lines, a.mode = nil, modeNormal
	}
}

func (a *assembler) finish() {
	if a.cur == nil {
		return
	}
	a.cur.Text = Mask(strings.TrimRight(strings.Join(a.lines, "\n"), "\n"))
	a.emit(*a.cur)
	a.cur = nil
}
