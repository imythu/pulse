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
}

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
	return nil
}

// WebSocketURL 把 http(s) 地址换成 ws(s)。
func (c *Config) WebSocketURL() string {
	if strings.HasPrefix(c.Server, "https://") {
		return "wss://" + strings.TrimPrefix(c.Server, "https://") + "/agent/ws"
	}
	return "ws://" + strings.TrimPrefix(c.Server, "http://") + "/agent/ws"
}
