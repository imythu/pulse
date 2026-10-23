package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"pulse/agent/internal/collect"
	"pulse/agent/internal/config"
	"pulse/agent/internal/identity"
	"pulse/agent/internal/protocol"
)

// Enroll 生成密钥对，用一次性令牌向服务器注册，保存身份文件。
func Enroll(ctx context.Context, cfg *config.Config, token, version string, extraLabels map[string]string) (string, error) {
	if _, err := identity.Load(cfg.DataDir); err == nil {
		return "", errors.New("本机已注册；如需重新注册，请先删除数据目录下的 identity.json")
	}
	pub, priv, err := identity.Generate()
	if err != nil {
		return "", err
	}
	labels := map[string]string{}
	for k, v := range cfg.Labels {
		labels[k] = v
	}
	for k, v := range extraLabels {
		labels[k] = v
	}
	body, _ := json.Marshal(protocol.EnrollRequest{
		Token:        token,
		PublicKey:    base64.StdEncoding.EncodeToString(pub),
		Host:         collect.HostInfo(ctx, labels),
		AgentVersion: version,
	})

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, cfg.Server+"/agent/enroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("连接服务器失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e)
		return "", fmt.Errorf("注册失败（HTTP %d）：%s", resp.StatusCode, e.Message)
	}
	var out protocol.EnrollResponse
	if err := json.Unmarshal(raw, &out); err != nil || out.AgentID == "" {
		return "", errors.New("服务器返回格式错误")
	}
	id := &identity.Identity{AgentID: out.AgentID, Server: cfg.Server, PrivateKey: priv}
	if err := id.Save(cfg.DataDir); err != nil {
		return "", fmt.Errorf("保存身份文件：%w", err)
	}
	return out.AgentID, nil
}
