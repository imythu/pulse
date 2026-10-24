// Package config 读取 /etc/pulse/agent.yaml。
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"pulse/agent/internal/protocol"
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
	// 服务器指令签名公钥（base64）。不写时用注册时服务器给的
	SigningPublicKey string    `yaml:"signing_public_key"`
	Commands         Commands  `yaml:"commands"`
	Services         []Service `yaml:"services"`
}

// Commands 是本机对指令的最终限制（设计文档 3.5）：服务器无法突破。
type Commands struct {
	// 默认开启；false 时拒绝所有指令
	Enabled *bool `yaml:"enabled"`
	// 为空时允许全部只读模板；写操作（如 svc.restart）必须显式列出
	Allow []string `yaml:"allow"`
	// 除 logs.files 外，log.tail / log.grep 还允许读取的文件 glob
	LogPaths []string        `yaml:"log_paths"`
	Custom   []CustomCommand `yaml:"custom"`
}

func (c Commands) IsEnabled() bool { return c.Enabled == nil || *c.Enabled }

// CustomCommand 是本机登记的自定义指令，模板名为 custom.<name>。exec 中的 {参数名} 会被整体替换，不经过 shell。
type CustomCommand struct {
	Name           string                  `yaml:"name"`
	Description    string                  `yaml:"description"`
	Risk           string                  `yaml:"risk"`
	TimeoutSeconds int                     `yaml:"timeout_seconds"`
	Exec           []string                `yaml:"exec"`
	Params         []protocol.CommandParam `yaml:"params"`
}

// Service 声明本机运行的服务和读取当前部署版本的方式（设计文档 7.3）。
type Service struct {
	Name string `yaml:"name"`
	// 内容为提交号的文件，如 /opt/app/REVISION
	VersionFile string `yaml:"version_file"`
	// 容器名，读取镜像 label org.opencontainers.image.revision
	Container string `yaml:"container"`
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

var customNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

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
	for i := range c.Commands.Custom {
		cc := &c.Commands.Custom[i]
		if !customNameRe.MatchString(cc.Name) {
			return fmt.Errorf("commands.custom[%d].name 只能包含小写字母、数字和 -", i)
		}
		if cc.Risk == "" {
			cc.Risk = "read"
		}
		if cc.Risk != "read" && cc.Risk != "write" {
			return fmt.Errorf("commands.custom[%d].risk 只能是 read 或 write", i)
		}
		if cc.TimeoutSeconds <= 0 {
			cc.TimeoutSeconds = 30
		}
		cc.TimeoutSeconds = min(cc.TimeoutSeconds, 300)
		if len(cc.Exec) == 0 || !strings.HasPrefix(cc.Exec[0], "/") {
			return fmt.Errorf("commands.custom[%d].exec 第一项必须是可执行文件的绝对路径", i)
		}
		for j, p := range cc.Params {
			switch p.Type {
			case "":
				cc.Params[j].Type = "string"
			case "string", "int", "duration", "enum":
			default:
				return fmt.Errorf("commands.custom[%d].params[%d].type 不支持 %q", i, j, p.Type)
			}
			if p.Type == "string" || p.Type == "" {
				if p.Pattern == "" {
					return fmt.Errorf("commands.custom[%d].params[%d] 是字符串参数，必须写 pattern 限定取值", i, j)
				}
			}
		}
	}
	for i, s := range c.Services {
		if s.Name == "" || (s.VersionFile == "" && s.Container == "") {
			return fmt.Errorf("services[%d] 需要 name，以及 version_file 或 container", i)
		}
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
