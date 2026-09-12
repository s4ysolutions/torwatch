package torrents

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

type fakeTorrent struct {
	gotInfo chan struct{}
	files   []FileInfo
	name    string
	data    []byte
}

func (f *fakeTorrent) GotInfo() <-chan struct{} { return f.gotInfo }
func (f *fakeTorrent) Files() []FileInfo        { return f.files }
func (f *fakeTorrent) Name() string             { return f.name }
func (f *fakeTorrent) Drop()                    {}

type nopSeekCloser struct{ io.ReadSeeker }

func (nopSeekCloser) Close() error { return nil }

func (f *fakeTorrent) FileReader(index int) (io.ReadSeekCloser, int64, error) {
	if index < 0 || index >= len(f.files) {
		return nil, 0, fmt.Errorf("%w: bad file index %d", ErrNotFound, index)
	}
	return nopSeekCloser{bytes.NewReader(f.data)}, f.files[index].Size, nil
}

type fakeClient struct {
	mu       sync.Mutex
	gotInfo  chan struct{}
	files    []FileInfo
	name     string
	addCalls int
	closed   bool
}

func newFakeClient() *fakeClient {
	return &fakeClient{
		gotInfo: make(chan struct{}),
		files:   []FileInfo{{Index: 0, Path: "video.mp4", Size: 12345}},
		name:    "video.mp4",
	}
}

func (c *fakeClient) AddMagnet(magnet string) (torrentIface, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.addCalls++
	return &fakeTorrent{gotInfo: c.gotInfo, files: c.files, name: c.name}, nil
}

func (c *fakeClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
}

func (c *fakeClient) releaseInfo() {
	c.mu.Lock()
	ch := c.gotInfo
	c.mu.Unlock()
	select {
	case <-ch:
	default:
		close(ch)
	}
}

func waitState(t *testing.T, m *Manager, id, want string) MagnetInfo {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		info, err := m.Info(id)
		if err != nil {
			t.Fatalf("Info(%q): %v", id, err)
		}
		if info.State == want {
			return info
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for state %q, last: %+v", want, info)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAddIdempotent(t *testing.T) {
	m := NewManagerWithClient(newFakeClient(), t.TempDir())
	defer m.Close()
	id1, err := m.Add("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")
	if err != nil {
		t.Fatalf("first Add: %v", err)
	}
	id2, err := m.Add("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")
	if err != nil {
		t.Fatalf("second Add: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("ids differ: %q %q", id1, id2)
	}
	if id1 != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("unexpected id: %q", id1)
	}
}

func TestInfoReady(t *testing.T) {
	fc := newFakeClient()
	m := NewManagerWithClient(fc, t.TempDir())
	defer m.Close()
	id, err := m.Add(testMagnet)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	info, err := m.Info(id)
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.State != "fetching-meta" {
		t.Fatalf("want fetching-meta before release, got %+v", info)
	}
	fc.releaseInfo() // unblock metadata
	info = waitState(t, m, id, "ready")
	if len(info.Files) == 0 || info.Files[0].Size == 0 {
		t.Fatalf("no files: %+v", info)
	}
}

func TestAddBadMagnet(t *testing.T) {
	m := NewManagerWithClient(newFakeClient(), t.TempDir())
	defer m.Close()
	if _, err := m.Add("not-a-magnet"); err == nil {
		t.Fatal("want error")
	}
}

func TestFileReaderUnknownMagnet(t *testing.T) {
	m := NewManagerWithClient(newFakeClient(), t.TempDir())
	defer m.Close()
	if _, _, err := m.FileReader("deadbeef", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestFileReaderBadIndex(t *testing.T) {
	m := NewManagerWithClient(newFakeClient(), t.TempDir())
	defer m.Close()
	id, err := m.Add(testMagnet)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, _, err := m.FileReader(id, 99); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
