package torrents

import (
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/anacrolix/torrent"
)

// ErrNotFound is returned when a magnet id (or file index) is unknown.
var ErrNotFound = errors.New("torrents: not found")

// MagnetInfo is the JSON state for one magnet.
type MagnetInfo struct {
	ID    string     `json:"id"`
	Name  string     `json:"name"`
	State string     `json:"state"` // fetching-meta | ready | error
	Error string     `json:"error,omitempty"`
	Files []FileInfo `json:"files"`
}

// FileInfo describes one file inside a torrent.
type FileInfo struct {
	Index int    `json:"index"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
}

// torrentIface mirrors the *torrent.Torrent methods Manager uses.
type torrentIface interface {
	GotInfo() <-chan struct{}
	Files() []FileInfo
	Name() string
	Drop()
	FileReader(index int) (io.ReadSeekCloser, int64, error)
}

// clientIface mirrors the *torrent.Client methods Manager uses.
type clientIface interface {
	AddMagnet(string) (torrentIface, error)
	Close()
}

type realTorrent struct{ t *torrent.Torrent }

func (r *realTorrent) GotInfo() <-chan struct{} { return r.t.GotInfo() }
func (r *realTorrent) Name() string             { return r.t.Name() }
func (r *realTorrent) Drop()                    { r.t.Drop() }
func (r *realTorrent) Files() []FileInfo {
	tf := r.t.Files()
	out := make([]FileInfo, len(tf))
	for i, f := range tf {
		out[i] = FileInfo{Index: i, Path: f.Path(), Size: f.Length()}
	}
	return out
}

// FileReader opens a seekable reader for file index. The anacrolix Reader
// prioritizes pieces near the read offset, so playback never waits for the
// full file.
func (r *realTorrent) FileReader(index int) (io.ReadSeekCloser, int64, error) {
	files := r.t.Files()
	if index < 0 || index >= len(files) {
		return nil, 0, fmt.Errorf("%w: bad file index %d", ErrNotFound, index)
	}
	f := files[index]
	return f.NewReader(), f.Length(), nil
}

type realClient struct{ c *torrent.Client }

func (r *realClient) AddMagnet(uri string) (torrentIface, error) {
	t, err := r.c.AddMagnet(uri)
	if err != nil {
		return nil, err
	}
	return &realTorrent{t: t}, nil
}

func (r *realClient) Close() { r.c.Close() }

type entry struct {
	t     torrentIface
	state string
	files []FileInfo
	name  string
}

// Manager tracks magnets by infohash hex. Add is idempotent on infohash.
type Manager struct {
	mu      sync.Mutex
	client  clientIface
	byID    map[string]*entry
	dataDir string
}

// NewManagerWithClient builds a Manager over c (tests inject a fake).
func NewManagerWithClient(c clientIface, dataDir string) *Manager {
	return &Manager{client: c, byID: make(map[string]*entry), dataDir: dataDir}
}

// NewManager builds a Manager over a real anacrolix client.
func NewManager(dataDir string) (*Manager, error) {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = dataDir
	c, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	return NewManagerWithClient(&realClient{c: c}, dataDir), nil
}

// Add parses magnet, returns infohash hex. Same magnet twice → same id.
func (m *Manager) Add(magnet string) (string, error) {
	spec, err := torrent.TorrentSpecFromMagnetUri(magnet)
	if err != nil {
		return "", err
	}
	id := spec.InfoHash.HexString()
	m.mu.Lock()
	if _, ok := m.byID[id]; ok {
		m.mu.Unlock()
		return id, nil
	}
	t, err := m.client.AddMagnet(magnet)
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	e := &entry{t: t, state: "fetching-meta"}
	m.byID[id] = e
	m.mu.Unlock()
	go func() {
		<-t.GotInfo()
		m.mu.Lock()
		defer m.mu.Unlock()
		e.state = "ready"
		e.files = t.Files()
		e.name = t.Name()
	}()
	return id, nil
}

// Info returns current state for id.
func (m *Manager) Info(id string) (MagnetInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.byID[id]
	if !ok {
		return MagnetInfo{}, fmt.Errorf("%w: unknown magnet %q", ErrNotFound, id)
	}
	files := append([]FileInfo(nil), e.files...)
	if files == nil {
		files = []FileInfo{}
	}
	return MagnetInfo{ID: id, Name: e.name, State: e.state, Files: files}, nil
}

// FileReader returns a seekable reader for file index of id.
// Thin lookup + NewReader so Task 4 can add a lastUsed touch here.
func (m *Manager) FileReader(id string, index int) (io.ReadSeekCloser, int64, error) {
	m.mu.Lock()
	e, ok := m.byID[id]
	m.mu.Unlock()
	if !ok {
		return nil, 0, fmt.Errorf("%w: unknown magnet %q", ErrNotFound, id)
	}
	return e.t.FileReader(index)
}

// Remove drops id from the client.
func (m *Manager) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		e.t.Drop()
		delete(m.byID, id)
	}
}

// Close stops the underlying client.
func (m *Manager) Close() {
	m.client.Close()
}
