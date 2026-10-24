// Package commands 接收、验签并执行服务器下发的指令模板（设计文档 3.5、10.2）。
//
// templates.json 是 packages/shared/commands/templates.json 的副本（make rules 同步，测试会校验两者一致）。
// 参数校验规则与服务端 validateArgs 相同；服务器已经校验过，Agent 不信任服务器，再校验一次。
package commands

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"pulse/agent/internal/protocol"
)

//go:embed templates.json
var templatesJSON []byte

var builtins = func() map[string]protocol.CommandTemplate {
	var f struct {
		Templates []protocol.CommandTemplate `json:"templates"`
	}
	if err := json.Unmarshal(templatesJSON, &f); err != nil {
		panic(fmt.Sprintf("templates.json 格式错误：%v", err))
	}
	m := make(map[string]protocol.CommandTemplate, len(f.Templates))
	for _, t := range f.Templates {
		m[t.Name] = t
	}
	return m
}()

// Builtin 返回内置模板。
func Builtin(name string) (protocol.CommandTemplate, bool) {
	t, ok := builtins[name]
	return t, ok
}

// ParseDuration 解析 30s / 15m / 1h / 7d，返回秒数。
func ParseDuration(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || len(s) > 8 {
		return 0, false
	}
	n, err := strconv.ParseInt(s[:len(s)-1], 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	switch s[len(s)-1] {
	case 's':
		return n, true
	case 'm':
		return n * 60, true
	case 'h':
		return n * 3600, true
	case 'd':
		return n * 86400, true
	}
	return 0, false
}

var intRe = regexp.MustCompile(`^-?\d{1,10}$`)

// Validate 按模板校验参数并补上默认值。
func Validate(t protocol.CommandTemplate, input map[string]string) (map[string]string, error) {
	for k := range input {
		found := false
		for _, p := range t.Params {
			found = found || p.Name == k
		}
		if !found {
			return nil, fmt.Errorf("模板 %s 不支持参数 %s", t.Name, k)
		}
	}
	out := map[string]string{}
	for _, p := range t.Params {
		v, ok := input[p.Name]
		if !ok || v == "" {
			v = p.Default
		}
		label := p.Label
		if label == "" {
			label = p.Name
		}
		if v == "" {
			if p.Required {
				return nil, fmt.Errorf("缺少参数 %s", label)
			}
			continue
		}
		v = strings.TrimSpace(v)
		inRange := func(n float64) bool {
			return (p.Min == nil || n >= *p.Min) && (p.Max == nil || n <= *p.Max)
		}
		switch p.Type {
		case "int":
			if !intRe.MatchString(v) {
				return nil, fmt.Errorf("%s 必须是整数", label)
			}
			n, _ := strconv.ParseInt(v, 10, 64)
			if !inRange(float64(n)) {
				return nil, fmt.Errorf("%s 超出允许范围", label)
			}
			v = strconv.FormatInt(n, 10)
		case "duration":
			n, ok := ParseDuration(v)
			if !ok {
				return nil, fmt.Errorf("%s 格式应为 30s、15m、1h、7d", label)
			}
			if !inRange(float64(n)) {
				return nil, fmt.Errorf("%s 超出允许范围", label)
			}
		case "enum":
			found := false
			for _, o := range p.Options {
				found = found || o == v
			}
			if !found {
				return nil, fmt.Errorf("%s 只能是 %s", label, strings.Join(p.Options, " / "))
			}
		case "string":
			if len(v) > 1024*3 {
				return nil, fmt.Errorf("%s 过长", label)
			}
		default:
			return nil, fmt.Errorf("参数 %s 的类型 %q 不支持", p.Name, p.Type)
		}
		if p.Pattern != "" {
			re, err := regexp.Compile(p.Pattern)
			if err != nil {
				return nil, fmt.Errorf("参数 %s 的校验规则无效", p.Name)
			}
			if !re.MatchString(v) {
				return nil, fmt.Errorf("%s 格式不正确", label)
			}
		}
		if p.Name == "path" || p.Name == "source" {
			for _, seg := range strings.Split(v, "/") {
				if seg == ".." {
					return nil, fmt.Errorf("%s 不能包含 ..", label)
				}
			}
		}
		out[p.Name] = v
	}
	return out, nil
}
