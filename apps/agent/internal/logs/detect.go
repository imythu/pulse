// Package logs 采集日志中的异常记录（设计文档 3.3）：跟踪文件和 journald，合并多行堆栈，
// 只保留 ERROR / FATAL 级别或命中关键字的记录，脱敏后按指纹在 10 秒窗口内计数。
package logs

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// 级别
const (
	LevelError = "error"
	LevelFatal = "fatal"
)

// DefaultKeywords 用于没有明确级别的行。命中 FatalKeywords 的记为 fatal，其余记为 error。
var DefaultKeywords = []string{
	"Exception", "Traceback (most recent call last)", "panic:", "segfault", "Out of memory",
	"oom-kill", "OutOfMemoryError", "timed out", "timeout",
}

var fatalKeywords = []string{"panic:", "segfault", "Out of memory", "oom-kill", "OutOfMemoryError"}

// 只在行首附近找级别，避免把消息正文里的 "error" 当成级别
const levelScanBytes = 160

var (
	upperLevel = regexp.MustCompile(`(?:^|[^A-Za-z])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE|EMERG|ALERT)(?:[^A-Za-z]|$)`)
	lowerLevel = regexp.MustCompile(`(?i)(?:\[|level=|lvl=|severity=)(trace|debug|info|notice|warn|warning|error|err|fatal|critical|crit|panic|severe|emerg|alert)\b`)
)

// Classifier 判断一行是否是异常记录的开头。
type Classifier struct {
	keywords []string
}

func NewClassifier(keywords []string) *Classifier {
	if len(keywords) == 0 {
		keywords = DefaultKeywords
	}
	return &Classifier{keywords: keywords}
}

// mapLevel 把日志里的级别词映射成 error / fatal；其他级别返回空串。
func mapLevel(word string) string {
	switch strings.ToUpper(word) {
	case "ERROR", "ERR", "SEVERE":
		return LevelError
	case "FATAL", "CRITICAL", "CRIT", "PANIC", "EMERG", "ALERT":
		return LevelFatal
	}
	return ""
}

// Classify 返回行首的级别。explicit 为 true 表示行里有明确的级别词（即使不是 error），
// 这时不再用关键字判断，避免 INFO 行里出现 "timeout" 也被上报。
func (c *Classifier) Classify(line string) (level string, explicit bool) {
	head := line
	if len(head) > levelScanBytes {
		head = head[:levelScanBytes]
	}
	pos, word := -1, ""
	if m := upperLevel.FindStringSubmatchIndex(head); m != nil {
		pos, word = m[2], head[m[2]:m[3]]
	}
	if m := lowerLevel.FindStringSubmatchIndex(head); m != nil && (pos < 0 || m[2] < pos) {
		pos, word = m[2], head[m[2]:m[3]]
	}
	if pos >= 0 {
		return mapLevel(word), true
	}
	return c.keywordLevel(line), false
}

func (c *Classifier) keywordLevel(line string) string {
	for _, k := range fatalKeywords {
		if strings.Contains(line, k) {
			return LevelFatal
		}
	}
	for _, k := range c.keywords {
		if strings.Contains(line, k) {
			return LevelError
		}
	}
	return ""
}

// ParseJSON 解析结构化日志行。返回的 text 由消息和错误字段组成，作为整条记录参与指纹计算；
// level 为空表示不是异常。ok 为 false 表示这一行不是 JSON 对象。
func (c *Classifier) ParseJSON(line string) (text, level string, ok bool) {
	if !strings.HasPrefix(line, "{") {
		return "", "", false
	}
	var m map[string]any
	if json.Unmarshal([]byte(line), &m) != nil {
		return "", "", false
	}
	msg := firstString(m, "msg", "message", "@message", "event")
	explicit := false
	for _, k := range []string{"level", "lvl", "severity", "levelname", "log.level"} {
		switch v := m[k].(type) {
		case string:
			level, explicit = mapLevel(v), true
		case float64: // pino / bunyan：50 = error，60 = fatal
			explicit = true
			if v >= 60 {
				level = LevelFatal
			} else if v >= 50 {
				level = LevelError
			}
		}
		if explicit {
			break
		}
	}
	parts := []string{msg}
	for _, k := range []string{"error", "err", "exception", "stack", "stack_trace", "stacktrace"} {
		switch v := m[k].(type) {
		case string:
			parts = append(parts, v)
		case map[string]any:
			if s := firstString(v, "stack", "message", "msg"); s != "" {
				parts = append(parts, s)
			}
		}
	}
	text = strings.TrimSpace(strings.Join(parts, "\n"))
	if text == "" {
		text = line
	}
	if !explicit {
		level = c.keywordLevel(text)
	}
	return text, level, true
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := m[k].(type) {
		case string:
			return v
		case nil:
		default:
			return fmt.Sprint(v)
		}
	}
	return ""
}

// unwrapDocker 取出 Docker json-file 日志驱动一行中的原始日志。
func unwrapDocker(line string) (string, bool) {
	var m struct {
		Log string `json:"log"`
	}
	if !strings.HasPrefix(line, "{") || json.Unmarshal([]byte(line), &m) != nil || m.Log == "" {
		return line, false
	}
	return strings.TrimRight(m.Log, "\r\n"), true
}
