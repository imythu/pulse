// pulse-agent：Pulse 监控探针。
//
//	pulse-agent enroll --config /etc/pulse/agent.yaml --token <令牌> [--label k=v]
//	pulse-agent run    --config /etc/pulse/agent.yaml
//	pulse-agent version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"pulse/agent/internal/agent"
	"pulse/agent/internal/config"
)

var version = "dev"

type labelFlags map[string]string

func (l labelFlags) String() string { return fmt.Sprint(map[string]string(l)) }
func (l labelFlags) Set(v string) error {
	k, val, ok := strings.Cut(v, "=")
	if !ok || k == "" {
		return errors.New("标签格式应为 key=value")
	}
	l[k] = val
	return nil
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "enroll":
		fs := flag.NewFlagSet("enroll", flag.ExitOnError)
		cfgPath := fs.String("config", "/etc/pulse/agent.yaml", "配置文件")
		token := fs.String("token", "", "注册令牌")
		labels := labelFlags{}
		fs.Var(labels, "label", "附加标签 key=value，可重复")
		_ = fs.Parse(os.Args[2:])
		if *token == "" {
			fail(errors.New("缺少 --token"))
		}
		cfg, err := config.Load(*cfgPath)
		if err != nil {
			fail(err)
		}
		id, err := agent.Enroll(ctx, cfg, *token, version, labels)
		if err != nil {
			fail(err)
		}
		fmt.Printf("注册成功，Agent ID：%s\n", id)
	case "run":
		fs := flag.NewFlagSet("run", flag.ExitOnError)
		cfgPath := fs.String("config", "/etc/pulse/agent.yaml", "配置文件")
		_ = fs.Parse(os.Args[2:])
		cfg, err := config.Load(*cfgPath)
		if err != nil {
			fail(err)
		}
		a, err := agent.New(cfg, version, log)
		if err != nil {
			fail(err)
		}
		log.Info("pulse-agent 启动", "version", version, "server", cfg.Server)
		if err := a.Run(ctx); err != nil {
			fail(err)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "用法：pulse-agent <enroll|run|version> [参数]")
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "错误：", err)
	os.Exit(1)
}
