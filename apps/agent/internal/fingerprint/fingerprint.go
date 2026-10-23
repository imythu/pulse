// Package fingerprint 计算日志指纹（设计文档 4.1）。
//
// rules.json 是 packages/shared/fingerprint/rules.json 的副本（make rules 同步，测试会校验两者一致），
// 服务端的 TS 实现用同一份规则，两边都跑 packages/shared/fingerprint/cases.json 里的用例。
package fingerprint

import (
	"crypto/sha1"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed rules.json
var rulesJSON []byte

type replacer struct {
	re      *regexp.Regexp
	replace string
}

type ruleSet struct {
	version        int
	maxFrames      int
	strip          []*regexp.Regexp
	placeholders   []replacer
	exceptionTypes []replacer
	frames         []replacer
	framework      *regexp.Regexp
}

var rules = mustLoad(rulesJSON)

// Version 是指纹规则版本，随 hello 上报。
var Version = rules.version

// 规则文件里用 JS 风格的 $1，Go 的 Expand 会把 $1x 当成名为 1x 的分组，统一改成 ${1}。
var dollarRef = regexp.MustCompile(`\$([0-9])`)

func goTemplate(s string) string { return dollarRef.ReplaceAllString(s, "$${$1}") }

func mustLoad(data []byte) *ruleSet {
	var raw struct {
		Version      int      `json:"version"`
		MaxFrames    int      `json:"maxFrames"`
		Strip        []string `json:"strip"`
		Placeholders []struct {
			Pattern string `json:"pattern"`
			Replace string `json:"replace"`
		} `json:"placeholders"`
		ExceptionTypes []struct {
			Pattern string `json:"pattern"`
			Type    string `json:"type"`
		} `json:"exceptionTypes"`
		Frames []struct {
			Pattern string `json:"pattern"`
			Frame   string `json:"frame"`
		} `json:"frames"`
		FrameworkFrames string `json:"frameworkFrames"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		panic(fmt.Sprintf("指纹规则格式错误：%v", err))
	}
	r := &ruleSet{version: raw.Version, maxFrames: raw.MaxFrames, framework: regexp.MustCompile(raw.FrameworkFrames)}
	for _, p := range raw.Strip {
		r.strip = append(r.strip, regexp.MustCompile(p))
	}
	for _, p := range raw.Placeholders {
		r.placeholders = append(r.placeholders, replacer{regexp.MustCompile(p.Pattern), goTemplate(p.Replace)})
	}
	for _, p := range raw.ExceptionTypes {
		r.exceptionTypes = append(r.exceptionTypes, replacer{regexp.MustCompile(p.Pattern), goTemplate(p.Type)})
	}
	for _, p := range raw.Frames {
		r.frames = append(r.frames, replacer{regexp.MustCompile(p.Pattern), goTemplate(p.Frame)})
	}
	return r
}

func expand(re *regexp.Regexp, line, tmpl string) (string, bool) {
	m := re.FindStringSubmatchIndex(line)
	if m == nil {
		return "", false
	}
	return string(re.ExpandString(nil, tmpl, line, m)), true
}

func mask(s string) string {
	for _, p := range rules.placeholders {
		s = p.re.ReplaceAllString(s, p.replace)
	}
	return strings.Trim(s, " \t")
}

// Template 把一条（可能多行的）异常记录变成模板，算法与 TS 版 logTemplate 一致。
func Template(record string) string {
	lines := strings.Split(record, "\n")
	header := lines[0]
	for _, re := range rules.strip {
		header = re.ReplaceAllString(header, "")
	}
	parts := []string{mask(header)}

	typ := ""
	for _, line := range lines {
		for _, p := range rules.exceptionTypes {
			if t, ok := expand(p.re, line, p.replace); ok {
				typ = t
				break
			}
		}
		if typ != "" {
			break
		}
	}
	if typ != "" {
		parts = append(parts, typ)
	}

	n := 0
	for _, line := range lines[1:] {
		if n >= rules.maxFrames {
			break
		}
		for _, p := range rules.frames {
			frame, ok := expand(p.re, line, p.replace)
			if !ok {
				continue
			}
			if !rules.framework.MatchString(frame) {
				parts = append(parts, "  at "+mask(frame))
				n++
			}
			break
		}
	}
	return strings.Join(parts, "\n")
}

// Of 由服务名、级别和模板算出 16 位十六进制指纹。
func Of(service, level, template string) string {
	sum := sha1.Sum([]byte(service + "\n" + level + "\n" + template))
	return hex.EncodeToString(sum[:])[:16]
}
