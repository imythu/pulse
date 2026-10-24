VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test rules
# 第一版只支持 Linux amd64
build: rules
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '$(LDFLAGS)' -o bin/pulse-agent-linux-amd64 ./cmd/pulse-agent

test:
	go test ./...

# 指纹规则和指令模板以 packages/shared 中的为准，Go 侧通过 go:embed 打包一份副本
rules:
	cp ../../packages/shared/fingerprint/rules.json internal/fingerprint/rules.json
	cp ../../packages/shared/commands/templates.json internal/commands/templates.json
