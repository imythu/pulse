// Package protocol 定义 Agent 与服务器之间的消息，字段名与 packages/shared/src/protocol.ts 保持一致。
package protocol

import "fmt"

const Version = 1

// 消息类型
const (
	TypeHello     = "hello"
	TypeMetrics   = "metrics"
	TypeProcs     = "procs"
	TypeHeartbeat = "heartbeat"
	TypeAck       = "ack"
	TypeConfig    = "config"
)

// Envelope 是所有消息的外层结构。
type Envelope[T any] struct {
	Type    string `json:"type"`
	Seq     int64  `json:"seq"`
	Ts      int64  `json:"ts"`
	Payload T      `json:"payload"`
}

type MetricPoint struct {
	Name string  `json:"name"`
	Tag  string  `json:"tag"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
	Avg  float64 `json:"avg"`
	P95  float64 `json:"p95"`
}

type HostInfo struct {
	Hostname        string            `json:"hostname"`
	OS              string            `json:"os"`
	Platform        string            `json:"platform"`
	PlatformVersion string            `json:"platformVersion"`
	Kernel          string            `json:"kernel"`
	Arch            string            `json:"arch"`
	CPUCores        int               `json:"cpuCores"`
	CPUModel        string            `json:"cpuModel"`
	MemTotal        uint64            `json:"memTotal"`
	IPs             []string          `json:"ips"`
	Labels          map[string]string `json:"labels"`
	BootTime        int64             `json:"bootTime"`
}

type ProcessInfo struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	Cmdline  string  `json:"cmdline"`
	User     string  `json:"user"`
	CPUPct   float64 `json:"cpuPct"`
	MemPct   float64 `json:"memPct"`
	RSSBytes uint64  `json:"rssBytes"`
}

type HelloPayload struct {
	Protocol     int               `json:"protocol"`
	AgentVersion string            `json:"agentVersion"`
	Host         HostInfo          `json:"host"`
	Commands     []CommandTemplate `json:"commands"`
	Versions     []ServiceVersion  `json:"versions"`
}

type MetricsPayload struct {
	WindowStart   int64         `json:"windowStart"`
	WindowSeconds int           `json:"windowSeconds"`
	Early         bool          `json:"early"`
	Points        []MetricPoint `json:"points"`
}

type ProcsPayload struct {
	ByCPU []ProcessInfo `json:"byCpu"`
	ByMem []ProcessInfo `json:"byMem"`
}

type HeartbeatPayload struct {
	QueueDepth    int              `json:"queueDepth"`
	UptimeSeconds float64          `json:"uptimeSeconds"`
	CPUPct        float64          `json:"cpuPct"`
	MemPct        float64          `json:"memPct"`
	Versions      []ServiceVersion `json:"versions"`
}

type AckPayload struct {
	MaxSeq int64 `json:"maxSeq"`
}

type EarlyPush struct {
	CPUPct  float64 `json:"cpuPct"`
	MemPct  float64 `json:"memPct"`
	DiskPct float64 `json:"diskPct"`
}

type Config struct {
	SampleIntervalSeconds int       `json:"sampleIntervalSeconds"`
	WindowSeconds         int       `json:"windowSeconds"`
	ProcsIntervalSeconds  int       `json:"procsIntervalSeconds"`
	HeartbeatSeconds      int       `json:"heartbeatSeconds"`
	EarlyPush             EarlyPush `json:"earlyPush"`
}

// DefaultConfig 与服务器的 DEFAULT_AGENT_CONFIG 一致，连上服务器前使用。
var DefaultConfig = Config{
	SampleIntervalSeconds: 10,
	WindowSeconds:         60,
	ProcsIntervalSeconds:  30,
	HeartbeatSeconds:      15,
	EarlyPush:             EarlyPush{CPUPct: 90, MemPct: 90, DiskPct: 85},
}

type EnrollRequest struct {
	Token        string   `json:"token"`
	PublicKey    string   `json:"publicKey"`
	Host         HostInfo `json:"host"`
	AgentVersion string   `json:"agentVersion"`
}

type EnrollResponse struct {
	AgentID          string `json:"agentId"`
	SigningPublicKey string `json:"signingPublicKey"`
}

// AuthMessage 是 WebSocket 握手时需要签名的内容。
func AuthMessage(agentID string, ts int64) string {
	return fmt.Sprintf("pulse-agent-auth:%s:%d", agentID, ts)
}

const TypeLogs = "logs"

// LogEvent 是一个指纹在一个窗口内的汇总：首条完整样本 + 次数（设计文档 4.1）。
type LogEvent struct {
	Fingerprint string   `json:"fingerprint"`
	Service     string   `json:"service"`
	Level       string   `json:"level"`
	Source      string   `json:"source"`
	Message     string   `json:"message"`
	Context     []string `json:"context"`
	Count       int      `json:"count"`
	FirstTs     int64    `json:"firstTs"`
	LastTs      int64    `json:"lastTs"`
}

type LogsPayload struct {
	RulesVersion int        `json:"rulesVersion"`
	Events       []LogEvent `json:"events"`
	// 本窗口因指纹数超过上限而只计数、没有样本的记录数
	Dropped int `json:"dropped"`
}

// ---------- 指令（设计文档 3.5） ----------

const (
	TypeCmdRun    = "cmd.run"
	TypeCmdCancel = "cmd.cancel"
	TypeCmdStatus = "cmd.status"
	TypeCmdOutput = "cmd.output"
	TypeCmdDone   = "cmd.done"
)

// CmdRunPayload：Body 是服务器签名的 SignedCommand JSON 文本，Signature 是对它的 Ed25519 签名（base64）。
type CmdRunPayload struct {
	Body      string `json:"body"`
	Signature string `json:"signature"`
}

type SignedCommand struct {
	V              int               `json:"v"`
	Kind           string            `json:"kind"`
	ID             string            `json:"id"`
	HostID         string            `json:"hostId"`
	Template       string            `json:"template"`
	Args           map[string]string `json:"args"`
	ExpiresAt      int64             `json:"expiresAt"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}

type CmdCancelPayload struct {
	ID string `json:"id"`
}

type CmdStatusPayload struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type CmdOutputPayload struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

type CmdDonePayload struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"` // succeeded / failed / timeout / rejected / canceled
	ExitCode   *int    `json:"exitCode"`
	Output     string  `json:"output"`
	Truncated  bool    `json:"truncated"`
	Error      string  `json:"error"`
	DurationMs float64 `json:"durationMs"`
}

// CommandParam / CommandTemplate 与 packages/shared/src/commands.ts 一致。
type CommandParam struct {
	Name     string   `json:"name" yaml:"name"`
	Label    string   `json:"label" yaml:"label"`
	Type     string   `json:"type" yaml:"type"`
	Required bool     `json:"required" yaml:"required"`
	Pattern  string   `json:"pattern,omitempty" yaml:"pattern"`
	Min      *float64 `json:"min,omitempty" yaml:"min"`
	Max      *float64 `json:"max,omitempty" yaml:"max"`
	Options  []string `json:"options,omitempty" yaml:"options"`
	Default  string   `json:"default,omitempty" yaml:"default"`
	Hint     string   `json:"hint,omitempty" yaml:"hint"`
}

type CommandTemplate struct {
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	Risk           string         `json:"risk"`
	TimeoutSeconds int            `json:"timeoutSeconds"`
	Params         []CommandParam `json:"params"`
}

// ServiceVersion 是服务当前部署的提交（设计文档 7.3）。
type ServiceVersion struct {
	Service string `json:"service"`
	Commit  string `json:"commit"`
	Source  string `json:"source"`
}
