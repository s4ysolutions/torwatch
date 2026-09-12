package torrents

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

// removeLocked drops id from the client and deletes its real storage path.
// anacrolix lays out bytes under dataDir/<torrent name>, not dataDir/<id>,
// so evict by the handle's Name() (captured before Drop); the legacy id
// path goes too. Best-effort: missing paths are fine (RemoveAll).
// Caller must hold m.mu.
func (m *Manager) removeLocked(id string) {
	e, ok := m.byID[id]
	if !ok {
		return
	}
	name := e.t.Name()
	if name == "" {
		name = e.name
	}
	e.t.Drop()
	delete(m.byID, id)
	if name != "" && name != id {
		_ = os.RemoveAll(filepath.Join(m.dataDir, name))
	}
	_ = os.RemoveAll(filepath.Join(m.dataDir, id))
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
func (m *Manager) RunCleanup(now func() time.Time, ttl time.Duration, maxDisk int64) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var removed []string
	t := now()
	// 1. TTL expiry.
	for id, e := range m.byID {
		if t.Sub(e.lastUsed) > ttl {
			m.removeLocked(id)
			removed = append(removed, id)
		}
	}
	// 2. Disk budget, LRU first. Re-measure after each eviction so
	// real deletes shrink the total; tests inject dirSize.
	size, _ := m.dirSize(m.dataDir)
	for size > maxDisk && len(m.byID) > 0 {
		oldest := m.oldestLastUsedLocked()
		if oldest == "" {
			break
		}
		m.removeLocked(oldest)
		removed = append(removed, oldest)
		size, _ = m.dirSize(m.dataDir)
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
