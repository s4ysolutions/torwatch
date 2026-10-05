package torrents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
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
	FileReader(ctx context.Context, index int) (io.ReadSeekCloser, int64, error)
}

// clientIface mirrors the *torrent.Client methods Manager uses.
type clientIface interface {
	AddMagnet(string) (torrentIface, error)
	AddTorrent(*metainfo.MetaInfo) (torrentIface, error)
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
// full file. Responsive: return what is available instead of filling the
// whole buffer. ctx (the HTTP request) unblocks a read waiting for pieces
// once the client goes away.
func (r *realTorrent) FileReader(ctx context.Context, index int) (io.ReadSeekCloser, int64, error) {
	files := r.t.Files()
	if index < 0 || index >= len(files) {
		return nil, 0, fmt.Errorf("%w: bad file index %d", ErrNotFound, index)
	}
	f := files[index]
	rd := f.NewReader()
	rd.SetContext(ctx)
	rd.SetResponsive()
	return rd, f.Length(), nil
}

type realClient struct{ c *torrent.Client }

func (r *realClient) AddMagnet(uri string) (torrentIface, error) {
	t, err := r.c.AddMagnet(uri)
	if err != nil {
		return nil, err
	}
	return &realTorrent{t: t}, nil
}

func (r *realClient) AddTorrent(mi *metainfo.MetaInfo) (torrentIface, error) {
	t, err := r.c.AddTorrent(mi)
	if err != nil {
		return nil, err
	}
	return &realTorrent{t: t}, nil
}

func (r *realClient) Close() { r.c.Close() }

type entry struct {
	t        torrentIface
	state    string
	err      string
	files    []FileInfo
	name     string
	lastUsed time.Time
	gone     chan struct{} // closed when the entry leaves the map
}

// DefaultMetaTimeout bounds the wait for torrent metadata (no peers).
const DefaultMetaTimeout = 10 * time.Minute

// Manager tracks magnets by infohash hex. Add is idempotent on infohash.
type Manager struct {
	mu          sync.Mutex
	client      clientIface
	byID        map[string]*entry
	dataDir     string
	dirSize     func(string) (int64, error)
	metaTimeout time.Duration
}

// NewManagerWithClient builds a Manager over c (tests inject a fake).
func NewManagerWithClient(c clientIface, dataDir string) *Manager {
	return &Manager{
		client:      c,
		byID:        make(map[string]*entry),
		dataDir:     dataDir,
		dirSize:     dirSizeWalk,
		metaTimeout: DefaultMetaTimeout,
	}
}

// Options configures the real torrent client.
type Options struct {
	// Upload lets peers download from this host while a torrent is active.
	// Off by default: the server then only leeches (never seeds after
	// completion either), which limits bandwidth and legal exposure at the
	// cost of slower swarms that reward reciprocity.
	Upload bool
	// ListenPort for BitTorrent peers; 0 = anacrolix default (42069),
	// negative = any free port (tests).
	ListenPort int
	// MetaTimeout: a torrent without metadata after this long is marked
	// "error". 0 = DefaultMetaTimeout.
	MetaTimeout time.Duration
}

// NewManager builds a Manager over a real anacrolix client.
func NewManager(dataDir string, opts Options) (*Manager, error) {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = dataDir
	cfg.NoUpload = !opts.Upload
	cfg.Seed = false
	if opts.ListenPort > 0 {
		cfg.ListenPort = opts.ListenPort
	} else if opts.ListenPort < 0 {
		cfg.ListenPort = 0
	}
	c, err := torrent.NewClient(cfg)
	if err != nil && errors.Is(err, syscall.EAFNOSUPPORT) {
		// Host without IPv6: the tcp6/udp6 listeners can't be created.
		cfg.DisableIPv6 = true
		c, err = torrent.NewClient(cfg)
	}
	if err != nil {
		return nil, err
	}
	m := NewManagerWithClient(&realClient{c: c}, dataDir)
	if opts.MetaTimeout > 0 {
		m.metaTimeout = opts.MetaTimeout
	}
	return m, nil
}

// Add parses magnet, returns infohash hex. Same magnet twice → same id.
func (m *Manager) Add(magnet string) (string, error) {
	spec, err := torrent.TorrentSpecFromMagnetUri(magnet)
	if err != nil {
		return "", err
	}
	return m.add(spec.InfoHash.HexString(), func() (torrentIface, error) { return m.client.AddMagnet(magnet) })
}

// AddTorrentFile parses raw .torrent bytes, returns infohash hex.
// Same entry map keyed by infohash: same torrent twice → same id.
func (m *Manager) AddTorrentFile(data []byte) (string, error) {
	mi, err := metainfo.Load(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	return m.add(mi.HashInfoBytes().HexString(), func() (torrentIface, error) { return m.client.AddTorrent(mi) })
}

// add registers id, opening the client handle only when id is new. The
// client call runs outside m.mu; the map is re-checked after
// (double-checked) so a concurrent add for the same id wins once and the
// duplicate handle is dropped. An entry in "error" state is evicted and
// re-added, so retrying a stalled magnet starts over.
func (m *Manager) add(id string, open func() (torrentIface, error)) (string, error) {
	m.mu.Lock()
	e, ok := m.byID[id]
	failed := ok && e.state == "error"
	if ok && !failed {
		e.lastUsed = time.Now()
	}
	m.mu.Unlock()
	if ok && !failed {
		return id, nil
	}
	if failed {
		m.evict(id)
	}
	t, err := open()
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	if e, ok := m.byID[id]; ok {
		e.lastUsed = time.Now()
		m.mu.Unlock()
		t.Drop() // duplicate handle; keep the registered one
		return id, nil
	}
	e = &entry{t: t, state: "fetching-meta", lastUsed: time.Now(), gone: make(chan struct{})}
	m.byID[id] = e
	timeout := m.metaTimeout
	m.mu.Unlock()
	go m.awaitInfo(id, e, timeout)
	return id, nil
}

// awaitInfo flips e to "ready" once metadata arrives, or "error" after
// timeout; returns early when e is evicted (no goroutine outlives it).
func (m *Manager) awaitInfo(id string, e *entry, timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-e.gone:
		return
	case <-timer.C:
		m.mu.Lock()
		defer m.mu.Unlock()
		if cur, ok := m.byID[id]; ok && cur == e && e.state == "fetching-meta" {
			e.state = "error"
			e.err = fmt.Sprintf("no metadata after %s (no reachable peers?)", timeout)
		}
	case <-e.t.GotInfo():
		m.mu.Lock()
		defer m.mu.Unlock()
		if cur, ok := m.byID[id]; !ok || cur != e {
			return // evicted (or replaced) while fetching meta
		}
		e.state = "ready"
		e.files = e.t.Files()
		e.name = e.t.Name()
	}
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
	return MagnetInfo{ID: id, Name: e.name, State: e.state, Error: e.err, Files: files}, nil
}

// FileReader returns a seekable reader for file index of id, bound to ctx.
// Touches lastUsed so retention treats playback as use.
func (m *Manager) FileReader(ctx context.Context, id string, index int) (io.ReadSeekCloser, int64, error) {
	m.mu.Lock()
	e, ok := m.byID[id]
	if ok {
		e.lastUsed = time.Now()
	}
	m.mu.Unlock()
	if !ok {
		return nil, 0, fmt.Errorf("%w: unknown magnet %q", ErrNotFound, id)
	}
	return e.t.FileReader(ctx, index)
}

// Remove drops id from the client. Unknown id → ErrNotFound.
// Client Drop and fs deletes run outside the lock (see evict).
func (m *Manager) Remove(id string) error {
	if !m.evict(id) {
		return fmt.Errorf("%w: unknown magnet %q", ErrNotFound, id)
	}
	return nil
}

// Close stops the underlying client. Safe on a nil client (tests) or nil
// receiver.
func (m *Manager) Close() {
	if m == nil || m.client == nil {
		return
	}
	m.client.Close()
}
