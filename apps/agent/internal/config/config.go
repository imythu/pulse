// Package config 读取 /etc/pulse/agent.yaml。
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  string            `yaml:"server"`
	DataDir string            `yaml:"data_dir"`
	Labels  map[string]string `yaml:"labels"`
	// 离线队列上限，超出后丢弃最旧的消息
	QueueMaxBytes int64 `yaml:"queue_max_bytes"`
	// 采集的磁盘挂载点会排除这些文件系统类型
	IgnoreFSTypes []string `yaml:"ignore_fs_types"`
	Logs          Logs     `yaml:"logs"`
}

// Logs 配置异常日志采集（设计文档 3.3）。
type Logs struct {
	Files    []LogFile `yaml:"files"`
	Journald Journald  `yaml:"journald"`
	// 没有明确级别的行命中这些关键字也算异常；为空时使用内置列表
	Keywords []string `yaml:"keywords"`
}

type LogFile struct {
	Service string   `yaml:"service"`
	Paths   []string `yaml:"paths"`
	// auto（默认）、plain、json、docker
	Format string `yaml:"format"`
}

type Journald struct {
	// 默认开启；不写时为 nil
	Enabled *bool `yaml:"enabled"`
	// 为空表示全部 unit
	Units []string `yaml:"units"`
	// 为空时用 unit 名作为服务名
	Service string `yaml:"service"`
}

func (j Journald) IsEnabled() bool { return j.Enabled == nil || *j.Enabled }

var defaultIgnoreFS = []string{
	"tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2",
	"devpts", "mqueue", "debugfs", "tracefs", "securityfs", "pstore", "bpf", "autofs",
	"fusectl", "configfs", "hugetlbfs", "nsfs", "ramfs", "rpc_pipefs", "binfmt_misc", "efivarfs",
	"selinuxfs", "fuse.lxcfs", "fuse.snapfuse", "fuse.gvfsd-fuse", "nfsd", "devfs", "shm",
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置 %s：%w", path, err)
	}
	var c Config
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("解析配置 %s：%w", path, err)
	}
	if err := c.normalize(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) normalize() error {
	c.Server = strings.TrimRight(c.Server, "/")
	u, err := url.Parse(c.Server)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("配置项 server 必须是 http(s):// 开头的地址")
	}
	if c.DataDir == "" {
		c.DataDir = "/var/lib/pulse-agent"
	}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	if c.QueueMaxBytes <= 0 {
		c.QueueMaxBytes = 100 << 20
	}
	if len(c.IgnoreFSTypes) == 0 {
		c.IgnoreFSTypes = defaultIgnoreFS
	}
	for i, f := range c.Logs.Files {
		if f.Service == "" || len(f.Paths) == 0 {
			return fmt.Errorf("logs.files[%d] 需要 service 和 paths", i)
		}
		switch f.Format {
		case "":
			c.Logs.Files[i].Format = "auto"
		case "auto", "plain", "json", "docker":
		default:
			return fmt.Errorf("logs.files[%d].format 只能是 auto、plain、json、docker", i)
		}
	}
	return nil
}

// WebSocketURL 把 http(s) 地址换成 ws(s)。
func (c *Config) WebSocketURL() string {
	if strings.HasPrefix(c.Server, "https://") {
		return "wss://" + strings.TrimPrefix(c.Server, "https://") + "/agent/ws"
	}
	return "ws://" + strings.TrimPrefix(c.Server, "http://") + "/agent/ws"
}
