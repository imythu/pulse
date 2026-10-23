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
	Protocol     int      `json:"protocol"`
	AgentVersion string   `json:"agentVersion"`
	Host         HostInfo `json:"host"`
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
	QueueDepth    int     `json:"queueDepth"`
	UptimeSeconds float64 `json:"uptimeSeconds"`
	CPUPct        float64 `json:"cpuPct"`
	MemPct        float64 `json:"memPct"`
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
	AgentID string `json:"agentId"`
}

// AuthMessage 是 WebSocket 握手时需要签名的内容。
func AuthMessage(agentID string, ts int64) string {
	return fmt.Sprintf("pulse-agent-auth:%s:%d", agentID, ts)
}
