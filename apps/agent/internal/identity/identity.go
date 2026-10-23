// Package identity 管理 Agent 的 Ed25519 身份：注册时生成，之后每次连接用它签名。
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"pulse/agent/internal/protocol"
)

const fileName = "identity.json"

type Identity struct {
	AgentID    string             `json:"agentId"`
	Server     string             `json:"server"`
	PrivateKey ed25519.PrivateKey `json:"privateKey"`
}

var ErrNotEnrolled = errors.New("尚未注册，请先运行 pulse-agent enroll")

func Generate() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

func Load(dataDir string) (*Identity, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, fileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, err
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, fmt.Errorf("身份文件损坏：%w", err)
	}
	if id.AgentID == "" || len(id.PrivateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("身份文件不完整")
	}
	return &id, nil
}

// Save 以 0600 权限原子写入身份文件。
func (id *Identity) Save(dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return err
	}
	raw, err := json.Marshal(id)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dataDir, fileName+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dataDir, fileName))
}

// AuthHeader 生成 `Pulse <agentId>.<ts>.<sig>`。
func (id *Identity) AuthHeader(now time.Time) string {
	ts := now.UnixMilli()
	sig := ed25519.Sign(id.PrivateKey, []byte(protocol.AuthMessage(id.AgentID, ts)))
	return fmt.Sprintf("Pulse %s.%d.%s", id.AgentID, ts, base64.RawURLEncoding.EncodeToString(sig))
}
