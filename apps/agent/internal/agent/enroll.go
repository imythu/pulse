package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
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
	signing, err := base64.StdEncoding.DecodeString(out.SigningPublicKey)
	if err != nil || len(signing) != ed25519.PublicKeySize {
		return "", errors.New("服务器没有返回有效的指令签名公钥")
	}
	id := &identity.Identity{AgentID: out.AgentID, Server: cfg.Server, PrivateKey: priv, SigningPublicKey: signing}
	if err := id.Save(cfg.DataDir); err != nil {
		return "", fmt.Errorf("保存身份文件：%w", err)
	}
	return out.AgentID, nil
}

// signingKey 确定用来验签指令的服务器公钥：配置文件优先，其次是注册时保存的；
// 都没有（M3 之前注册的 Agent）时向服务器取一次并保存。
func signingKey(ctx context.Context, cfg *config.Config, id *identity.Identity, log interface{ Warn(string, ...any) }) (ed25519.PublicKey, error) {
	if cfg.SigningPublicKey != "" {
		k, err := base64.StdEncoding.DecodeString(cfg.SigningPublicKey)
		if err != nil || len(k) != ed25519.PublicKeySize {
			return nil, errors.New("配置项 signing_public_key 不是有效的 Ed25519 公钥")
		}
		return k, nil
	}
	if len(id.SigningPublicKey) == ed25519.PublicKeySize {
		return id.SigningPublicKey, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Server+"/agent/signing-key", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		SigningPublicKey string `json:"signingPublicKey"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out); err != nil {
		return nil, err
	}
	k, err := base64.StdEncoding.DecodeString(out.SigningPublicKey)
	if err != nil || len(k) != ed25519.PublicKeySize {
		return nil, errors.New("服务器返回的签名公钥无效")
	}
	log.Warn("身份文件中没有指令签名公钥，已从服务器获取并保存；如需更强保证请在配置中写 signing_public_key")
	id.SigningPublicKey = k
	if err := id.Save(cfg.DataDir); err != nil {
		return nil, err
	}
	return k, nil
}
