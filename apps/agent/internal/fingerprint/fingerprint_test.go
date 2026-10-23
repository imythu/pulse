package fingerprint

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

const shared = "../../../../packages/shared/fingerprint/"

func TestRulesInSync(t *testing.T) {
	src, err := os.ReadFile(shared + "rules.json")
	if err != nil {
		t.Skipf("不在 monorepo 中运行：%v", err)
	}
	if !bytes.Equal(src, rulesJSON) {
		t.Fatal("rules.json 与 packages/shared/fingerprint/rules.json 不一致，运行 make rules 同步")
	}
}

func TestSharedCases(t *testing.T) {
	data, err := os.ReadFile(shared + "cases.json")
	if err != nil {
		t.Skipf("不在 monorepo 中运行：%v", err)
	}
	var cases []struct {
		Name, Service, Level, Record, Fingerprint, Template string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			tmpl := Template(c.Record)
			if tmpl != c.Template {
				t.Fatalf("模板不一致\n got: %q\nwant: %q", tmpl, c.Template)
			}
			if fp := Of(c.Service, c.Level, tmpl); fp != c.Fingerprint {
				t.Fatalf("指纹 %s，期望 %s", fp, c.Fingerprint)
			}
		})
	}
}
