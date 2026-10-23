package queue

import (
	"fmt"
	"testing"
)

func push(t *testing.T, q *Queue, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := q.Push("metrics", func(seq int64) ([]byte, error) {
			return []byte(fmt.Sprintf(`{"seq":%d}`, seq)), nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPushAckPending(t *testing.T) {
	q, err := Open(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	push(t, q, 5)
	if err := q.Ack(3); err != nil {
		t.Fatal(err)
	}
	msgs, _ := q.Pending(0, 10)
	if len(msgs) != 2 || msgs[0].Seq != 4 || string(msgs[1].Data) != `{"seq":5}` || q.Depth() != 2 {
		t.Fatalf("unexpected %+v", msgs)
	}
}

func TestSeqSurvivesReopenAndFollowsServer(t *testing.T) {
	dir := t.TempDir()
	q, _ := Open(dir, 1<<20)
	push(t, q, 2)
	q.Close()
	q, _ = Open(dir, 1<<20)
	defer q.Close()
	if q.Depth() != 2 {
		t.Fatalf("depth %d", q.Depth())
	}
	_ = q.Ack(100)
	m, _ := q.Push("metrics", func(seq int64) ([]byte, error) { return []byte("x"), nil })
	if m.Seq != 101 {
		t.Fatalf("seq %d", m.Seq)
	}
}

func TestDropsOldestWhenFull(t *testing.T) {
	q, _ := Open(t.TempDir(), 60)
	defer q.Close()
	push(t, q, 10)
	msgs, _ := q.Pending(0, 100)
	if len(msgs) == 0 || len(msgs) >= 10 || msgs[len(msgs)-1].Seq != 10 {
		t.Fatalf("unexpected %d msgs", len(msgs))
	}
}
