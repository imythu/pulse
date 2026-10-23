// Package transport 负责与服务器的 WebSocket 长连接：zstd 压缩的 JSON 帧、断线重连。
package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/klauspost/compress/zstd"
)

var (
	encoder, _ = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))
	decoder, _ = zstd.NewReader(nil, zstd.WithDecoderMaxMemory(16<<20))
)

const maxFrameBytes = 8 << 20

// Conn 包装一条已建立的连接。写操作串行化，读操作只能在一个 goroutine 里进行。
type Conn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func Dial(ctx context.Context, url, authHeader, userAgent string) (*Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {authHeader}, "User-Agent": {userAgent}},
	})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("连接被拒绝（HTTP %d）：%w", resp.StatusCode, err)
		}
		return nil, err
	}
	ws.SetReadLimit(maxFrameBytes)
	return &Conn{ws: ws}, nil
}

// SendRaw 发送已编码的 JSON。
func (c *Conn) SendRaw(ctx context.Context, data []byte) error {
	frame := encoder.EncodeAll(data, nil)
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, frame)
}

func (c *Conn) Send(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.SendRaw(ctx, data)
}

// Read 读取下一条消息并解压。
func (c *Conn) Read(ctx context.Context) ([]byte, error) {
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return data, nil
	}
	return decoder.DecodeAll(data, nil)
}

func (c *Conn) Close(reason string) {
	_ = c.ws.Close(websocket.StatusNormalClosure, reason)
}

// CloseCode 返回服务器关闭连接时给的状态码，没有则为 -1。
func CloseCode(err error) int {
	return int(websocket.CloseStatus(err))
}

// Backoff 是带随机抖动的指数退避：1s 起，上限 60s。
type Backoff struct {
	attempt int
}

func (b *Backoff) Next() time.Duration {
	base := time.Second << min(b.attempt, 6)
	if base > time.Minute {
		base = time.Minute
	}
	b.attempt++
	// 在 [base/2, base] 之间随机，避免服务器重启后所有 Agent 同时重连
	return base/2 + time.Duration(rand.Int64N(int64(base/2)+1))
}

func (b *Backoff) Reset() { b.attempt = 0 }
