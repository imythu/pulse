// Package queue 是基于 bbolt 的本地可靠队列：消息带单调递增的 seq，
// 服务器 ack 后删除；断线期间积压，重连后按 seq 补传（设计文档 3.4）。
package queue

import (
	"encoding/binary"
	"errors"
	"path/filepath"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketMsgs = []byte("msgs")
	bucketMeta = []byte("meta")
	keySeq     = []byte("seq")
)

// TypeLogs 与 protocol.TypeLogs 相同；队列不依赖 protocol 包，这里单独声明
const TypeLogs = "logs"

type Message struct {
	Seq  int64
	Type string
	Data []byte // 已编码的 JSON 信封
}

type Queue struct {
	db       *bolt.DB
	maxBytes int64

	mu    sync.Mutex
	bytes int64
	count int
}

func Open(dataDir string, maxBytes int64) (*Queue, error) {
	db, err := bolt.Open(filepath.Join(dataDir, "queue.db"), 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	q := &Queue{db: db, maxBytes: maxBytes}
	err = db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(bucketMeta); err != nil {
			return err
		}
		b, err := tx.CreateBucketIfNotExists(bucketMsgs)
		if err != nil {
			return err
		}
		return b.ForEach(func(_, v []byte) error {
			q.bytes += int64(len(v))
			q.count++
			return nil
		})
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return q, nil
}

func (q *Queue) Close() error { return q.db.Close() }

// Push 分配下一个 seq，用 build 生成消息内容并持久化。超出容量时先丢弃最旧的消息。
func (q *Queue) Push(typ string, build func(seq int64) ([]byte, error)) (Message, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var msg Message
	err := q.db.Update(func(tx *bolt.Tx) error {
		meta := tx.Bucket(bucketMeta)
		seq := int64(1)
		if v := meta.Get(keySeq); v != nil {
			seq = int64(binary.BigEndian.Uint64(v)) + 1
		}
		data, err := build(seq)
		if err != nil {
			return err
		}
		if err := meta.Put(keySeq, u64(seq)); err != nil {
			return err
		}
		b := tx.Bucket(bucketMsgs)
		if err := b.Put(u64(seq), encode(typ, data)); err != nil {
			return err
		}
		q.bytes += int64(len(data) + len(typ) + 1)
		q.count++
		if err := q.evict(b, seq); err != nil {
			return err
		}
		msg = Message{Seq: seq, Type: typ, Data: data}
		return nil
	})
	return msg, err
}

// evict 在超出容量时腾出空间：先丢最旧的指标等消息，异常日志最后才丢（设计文档 3.4）。
// 刚写入的 keep 这条永远保留。
func (q *Queue) evict(b *bolt.Bucket, keep int64) error {
	if q.bytes <= q.maxBytes {
		return nil
	}
	for _, spareLogs := range []bool{true, false} {
		var victims [][]byte
		over := q.bytes - q.maxBytes
		c := b.Cursor()
		for k, v := c.First(); k != nil && over > 0; k, v = c.Next() {
			if int64(binary.BigEndian.Uint64(k)) == keep {
				continue
			}
			if typ, _, _ := decode(v); spareLogs && typ == TypeLogs {
				continue
			}
			victims = append(victims, append([]byte(nil), k...))
			over -= int64(len(v))
		}
		for _, k := range victims {
			q.bytes -= int64(len(b.Get(k)))
			q.count--
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		if q.bytes <= q.maxBytes {
			return nil
		}
	}
	return nil
}

// Ack 删除 seq <= maxSeq 的所有消息。
func (q *Queue) Ack(maxSeq int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.db.Update(func(tx *bolt.Tx) error {
		c := tx.Bucket(bucketMsgs).Cursor()
		for k, v := c.First(); k != nil && int64(binary.BigEndian.Uint64(k)) <= maxSeq; k, v = c.First() {
			q.bytes -= int64(len(v))
			q.count--
			if err := c.Delete(); err != nil {
				return err
			}
		}
		// 服务器记录的 seq 比本地大（如本地数据目录被清空过），本地计数器跟上，避免新消息被当成重复丢弃
		meta := tx.Bucket(bucketMeta)
		if v := meta.Get(keySeq); v == nil || int64(binary.BigEndian.Uint64(v)) < maxSeq {
			return meta.Put(keySeq, u64(maxSeq))
		}
		return nil
	})
}

// Pending 按 seq 升序返回最多 limit 条未确认的消息。
func (q *Queue) Pending(afterSeq int64, limit int) ([]Message, error) {
	var out []Message
	err := q.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bucketMsgs).Cursor()
		for k, v := c.Seek(u64(afterSeq + 1)); k != nil && len(out) < limit; k, v = c.Next() {
			typ, data, err := decode(v)
			if err != nil {
				return err
			}
			out = append(out, Message{Seq: int64(binary.BigEndian.Uint64(k)), Type: typ, Data: append([]byte(nil), data...)})
		}
		return nil
	})
	return out, err
}

func (q *Queue) Depth() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.count
}

func u64(v int64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(v))
	return b
}

// 存储格式：类型 + 0 字节 + 数据
func encode(typ string, data []byte) []byte {
	out := make([]byte, 0, len(typ)+1+len(data))
	out = append(out, typ...)
	out = append(out, 0)
	return append(out, data...)
}

func decode(v []byte) (string, []byte, error) {
	for i, c := range v {
		if c == 0 {
			return string(v[:i]), v[i+1:], nil
		}
	}
	return "", nil, errors.New("队列消息损坏")
}
