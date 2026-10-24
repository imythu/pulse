package commands

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pulse/agent/internal/protocol"
)

const seenFile = "commands-seen.json"

// Verifier 校验服务器下发的指令：签名、用途、目标主机、有效期和重放。
// 执行过的指令 ID 落盘保存到过期为止，Agent 重启后同一条指令也不能再执行一次。
type Verifier struct {
	pub     ed25519.PublicKey
	agentID string
	dataDir string
	now     func() time.Time

	mu   sync.Mutex
	seen map[string]int64
}

func NewVerifier(pub ed25519.PublicKey, agentID, dataDir string) *Verifier {
	v := &Verifier{pub: pub, agentID: agentID, dataDir: dataDir, now: time.Now, seen: map[string]int64{}}
	if raw, err := os.ReadFile(filepath.Join(dataDir, seenFile)); err == nil {
		_ = json.Unmarshal(raw, &v.seen)
	}
	return v
}

// ErrRejected 包装所有校验失败，原因会回报给服务器。
var ErrRejected = errors.New("指令被拒绝")

func reject(format string, a ...any) error {
	return fmt.Errorf("%w：%s", ErrRejected, fmt.Sprintf(format, a...))
}

// Verify 验签并解析。返回的错误都是 ErrRejected。
func (v *Verifier) Verify(p protocol.CmdRunPayload) (protocol.SignedCommand, error) {
	var cmd protocol.SignedCommand
	if len(v.pub) != ed25519.PublicKeySize {
		return cmd, reject("Agent 没有服务器的指令签名公钥")
	}
	sig, err := base64.StdEncoding.DecodeString(p.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(v.pub, []byte(p.Body), sig) {
		return cmd, reject("签名无效")
	}
	if err := json.Unmarshal([]byte(p.Body), &cmd); err != nil {
		return cmd, reject("指令格式错误")
	}
	if cmd.V != 1 || cmd.Kind != "pulse-command" || cmd.ID == "" {
		return cmd, reject("不支持的指令版本")
	}
	if cmd.HostID != v.agentID {
		return cmd, reject("指令不是发给本机的")
	}
	now := v.now().UnixMilli()
	if cmd.ExpiresAt <= now {
		return cmd, reject("指令已过期")
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	if _, dup := v.seen[cmd.ID]; dup {
		return cmd, reject("重复的指令")
	}
	for id, exp := range v.seen {
		if exp <= now {
			delete(v.seen, id)
		}
	}
	v.seen[cmd.ID] = cmd.ExpiresAt
	if err := v.persist(); err != nil {
		// 记不下来就不执行：否则重启后可能被重放
		delete(v.seen, cmd.ID)
		return cmd, reject("无法记录已执行的指令：%v", err)
	}
	return cmd, nil
}

func (v *Verifier) persist() error {
	raw, _ := json.Marshal(v.seen)
	tmp := filepath.Join(v.dataDir, seenFile+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(v.dataDir, seenFile))
}
