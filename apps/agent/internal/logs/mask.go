package logs

import "regexp"

// 上报前打码（设计文档 3.3）。替换成固定占位符，打码后的文本仍能稳定地算出指纹。
var maskRules = []struct {
	re      *regexp.Regexp
	replace string
}{
	{regexp.MustCompile(`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+`), "<JWT>"},
	{regexp.MustCompile(`(?i)\bBearer [A-Za-z0-9._~+/=-]+`), "Bearer ***"},
	{regexp.MustCompile(`://[^/\s:@]+:[^/\s@]+@`), "://***:***@"},
	{regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)(["']?[ \t]*[:=][ \t]*["']?)[^ \t\r\n"',;&]+`), "${1}${2}***"},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`), "<EMAIL>"},
	{regexp.MustCompile(`\b1[3-9][0-9]{9}\b`), "<PHONE>"},
}

// Mask 打码手机号、邮箱、token、密码等字段。
func Mask(s string) string {
	for _, r := range maskRules {
		s = r.re.ReplaceAllString(s, r.replace)
	}
	return s
}
