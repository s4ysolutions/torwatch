package torrents

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// dirSizeWalk sums file sizes under root. Missing dir counts as zero.
func dirSizeWalk(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return total, err
	}
	return total, nil
}

// LastUsed reports when id was last added or read.
func (m *Manager) LastUsed(id string) (time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.byID[id]
	if !ok {
		return time.Time{}, fmt.Errorf("%w: unknown magnet %q", ErrNotFound, id)
	}
	return e.lastUsed, nil
}

// setLastUsed is a test helper to fake entry age.
func (m *Manager) setLastUsed(id string, t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		e.lastUsed = t
	}
}

// safeJoin resolves name under dataDir, rejecting anything that could
// escape it (empty, ".", "..", absolute paths, or names containing path
// separators — torrent metadata is attacker-controlled). ok=false means the
// caller must fall back to the id-only path and touch nothing else.
func safeJoin(dataDir, name string) (string, bool) {
	if name == "" || name == "." || name == ".." {
		return "", false
	}
	if filepath.IsAbs(name) {
		return "", false
	}
	if strings.ContainsRune(name, '/') || strings.ContainsRune(name, '\\') {
		return "", false
	}
	if name != filepath.Clean(name) {
		return "", false
	}
	base := filepath.Clean(dataDir)
	p := filepath.Join(base, name)
	// Defense in depth: verify containment after Join+Clean.
	if p == base || !strings.HasPrefix(p, base+string(os.PathSeparator)) {
		return "", false
	}
	return p, true
}

// storagePaths returns the on-disk paths owned by id: the sanitized name
// dir (when safe) plus the legacy id dir (infohash hex — always safe).
func storagePaths(dataDir, id, name string) []string {
	paths := []string{filepath.Join(filepath.Clean(dataDir), id)}
	if p, ok := safeJoin(dataDir, name); ok && name != id {
		paths = append(paths, p)
	}
	return paths
}

// planRemoveLocked drops id from the map and returns the client handle plus
// owned storage paths. Caller must hold m.mu. All client/fs I/O happens
// after unlock (see evict / RunCleanup).
func (m *Manager) planRemoveLocked(id string) (torrentIface, []string, bool) {
	e, ok := m.byID[id]
	if !ok {
		return nil, nil, false
	}
	name := e.t.Name()
	if name == "" {
		name = e.name
	}
	delete(m.byID, id)
	if e.gone != nil {
		close(e.gone)
	}
	return e.t, storagePaths(m.dataDir, id, name), true
}

// evict removes id without holding m.mu across client/fs I/O.
func (m *Manager) evict(id string) bool {
	m.mu.Lock()
	t, paths, ok := m.planRemoveLocked(id)
	m.mu.Unlock()
	if !ok {
		return false
	}
	t.Drop()
	for _, p := range paths {
		_ = os.RemoveAll(p)
	}
	return true
}

// oldestLastUsedLocked returns the id with the stalest lastUsed.
// Caller must hold m.mu. Empty map returns "".
func (m *Manager) oldestLastUsedLocked() string {
	oldest := ""
	var oldestT time.Time
	first := true
	for id, e := range m.byID {
		if first || e.lastUsed.Before(oldestT) {
			oldest, oldestT, first = id, e.lastUsed, false
		}
	}
	return oldest
}

// RunCleanup evicts expired entries (lastUsed older than ttl), then
// least-recently-used entries until dataDir fits maxDisk. One pass,
// exported for tests. Returns removed ids (TTL batch first, then LRU).
// Locking: entries are unlinked from the map under m.mu, but client Drop
// and RemoveAll run outside it; each disk-budget eviction re-plans under
// the lock (double-checked — a concurrent Remove may have won the race).
func (m *Manager) RunCleanup(now func() time.Time, ttl time.Duration, maxDisk int64) []string {
	t := now()
	// 1. TTL expiry: unlink under lock, I/O outside it.
	m.mu.Lock()
	var expired []string
	for id, e := range m.byID {
		if t.Sub(e.lastUsed) > ttl {
			expired = append(expired, id)
		}
	}
	type doomed struct {
		t     torrentIface
		paths []string
		id    string
	}
	jobs := make([]doomed, 0, len(expired))
	for _, id := range expired {
		if dt, paths, ok := m.planRemoveLocked(id); ok {
			jobs = append(jobs, doomed{dt, paths, id})
		}
	}
	dirSize := m.dirSize
	dataDir := m.dataDir
	m.mu.Unlock()
	var removed []string
	for _, j := range jobs {
		j.t.Drop()
		for _, p := range j.paths {
			_ = os.RemoveAll(p)
		}
		removed = append(removed, j.id)
	}
	// 2. Disk budget, LRU first. Re-measure after each eviction so
	// real deletes shrink the total; tests inject dirSize.
	for {
		size, _ := dirSize(dataDir)
		if size <= maxDisk {
			break
		}
		m.mu.Lock()
		if len(m.byID) == 0 {
			m.mu.Unlock()
			break
		}
		oldest := m.oldestLastUsedLocked()
		dt, paths, ok := m.planRemoveLocked(oldest)
		m.mu.Unlock()
		if !ok {
			break
		}
		dt.Drop()
		for _, p := range paths {
			_ = os.RemoveAll(p)
		}
		removed = append(removed, oldest)
	}
	return removed
}

// StartCleanup ticks every interval running RunCleanup until ctx ends.
func (m *Manager) StartCleanup(ctx context.Context, ttl time.Duration, maxDisk int64, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			m.RunCleanup(func() time.Time { return t }, ttl, maxDisk)
		}
	}
}
