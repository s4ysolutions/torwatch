package torrents

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const (
	testMagnetA = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testMagnetB = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

const (
	gb = 1 << 30
)

// newTestManager builds a Manager over a fake client for cleanup tests.
func newTestManager(t *testing.T) (*Manager, *fakeClient) {
	t.Helper()
	fc := newFakeClient()
	m := NewManagerWithClient(fc, t.TempDir())
	t.Cleanup(m.Close)
	return m, fc
}

func TestCleanupExpiredTTL(t *testing.T) {
	now := time.Now()
	m, fc := newTestManager(t)
	id, _ := m.Add(testMagnet)
	fc.releaseInfo()
	m.setLastUsed(id, now.Add(-25*time.Hour)) // test helper
	removed := m.RunCleanup(func() time.Time { return now }, 24*time.Hour, 1<<62)
	if len(removed) != 1 || removed[0] != id {
		t.Fatalf("removed %v", removed)
	}
}

func TestCleanupDiskBudgetLRU(t *testing.T) {
	now := time.Now()
	m, fc := newTestManager(t)
	idOld, err := m.Add(testMagnetA)
	if err != nil {
		t.Fatalf("Add A: %v", err)
	}
	idNew, err := m.Add(testMagnetB)
	if err != nil {
		t.Fatalf("Add B: %v", err)
	}
	fc.releaseInfo()
	// Oldest stays expired-free (fresh within TTL) so only the disk
	// budget pass decides; each torrent costs 15GB, budget 20GB.
	m.setLastUsed(idOld, now.Add(-2*time.Hour))
	m.setLastUsed(idNew, now.Add(-1*time.Hour))
	// Fake dataDir sizes 15GB + 15GB: total scales with live entries.
	m.dirSize = func(string) (int64, error) {
		return int64(len(m.byID)) * 15 * gb, nil
	}
	removed := m.RunCleanup(func() time.Time { return now }, 24*time.Hour, 20*gb)
	if len(removed) != 1 || removed[0] != idOld {
		t.Fatalf("want oldest %v removed, got %v", idOld, removed)
	}
	if _, err := m.Info(idNew); err != nil {
		t.Fatalf("newest should be kept: %v", err)
	}
	if _, err := m.Info(idOld); err == nil {
		t.Fatalf("oldest should be gone")
	}
}

func TestCleanupKeepsFresh(t *testing.T) {
	now := time.Now()
	m, fc := newTestManager(t)
	id, _ := m.Add(testMagnet)
	fc.releaseInfo()
	m.setLastUsed(id, now.Add(-1*time.Hour))
	m.dirSize = func(string) (int64, error) { return 0, nil }
	removed := m.RunCleanup(func() time.Time { return now }, 24*time.Hour, 1<<62)
	if len(removed) != 0 {
		t.Fatalf("removed fresh %v", removed)
	}
}

func TestFileReaderTouchesLastUsed(t *testing.T) {
	m, fc := newTestManager(t)
	id, err := m.Add(testMagnet)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	fc.releaseInfo()
	old := time.Now().Add(-2 * time.Hour)
	m.setLastUsed(id, old)
	rc, _, err := m.FileReader(context.Background(), id, 0)
	if err != nil {
		t.Fatalf("FileReader: %v", err)
	}
	rc.Close()
	got, err := m.LastUsed(id)
	if err != nil {
		t.Fatalf("LastUsed: %v", err)
	}
	if !got.After(old) {
		t.Fatalf("lastUsed not touched: %v vs %v", got, old)
	}
}

// TestCleanupRejectsHostileNames: torrent metadata names are
// attacker-controlled; eviction must never RemoveAll outside dataDir, even
// for names like "../../evil" or absolute paths. Only the legacy id dir
// goes; a sentinel file outside dataDir must survive.
func TestCleanupRejectsHostileNames(t *testing.T) {
	now := time.Now()
	parent := t.TempDir()
	dataDir := filepath.Join(parent, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	magnets := []string{testMagnetA, testMagnetB}
	hostiles := []string{
		"../../evil",
		filepath.Join(parent, "abs-evil"), // absolute path outside dataDir
		"..\\evil",
		"..",
		".",
		"",
	}
	// Sentinel files that must survive every subtest.
	sentinels := map[string]string{
		"../../evil":                      filepath.Join(parent, "evil"),
		"..\\evil":                        filepath.Join(parent, "evil"),
		"..":                              filepath.Join(parent, "evil"),
		".":                               filepath.Join(parent, "evil"),
		"":                                filepath.Join(parent, "evil"),
		filepath.Join(parent, "abs-evil"): filepath.Join(parent, "abs-evil"),
	}
	for i, hostile := range hostiles {
		fc := newFakeClient()
		fc.name = hostile
		m := NewManagerWithClient(fc, dataDir)
		t.Cleanup(m.Close)
		id, err := m.Add(magnets[i%len(magnets)])
		if err != nil {
			t.Fatalf("Add %q: %v", hostile, err)
		}
		sentinel := sentinels[hostile]
		if err := os.WriteFile(sentinel, []byte("sentinel"), 0o644); err != nil {
			t.Fatalf("write sentinel: %v", err)
		}
		legacyPath := filepath.Join(dataDir, id)
		if err := os.MkdirAll(legacyPath, 0o755); err != nil {
			t.Fatalf("mkdir legacy path: %v", err)
		}
		m.setLastUsed(id, now.Add(-25*time.Hour))
		removed := m.RunCleanup(func() time.Time { return now }, 24*time.Hour, 1<<62)
		if len(removed) != 1 || removed[0] != id {
			t.Fatalf("hostile %q: removed %v", hostile, removed)
		}
		if b, err := os.ReadFile(sentinel); err != nil || string(b) != "sentinel" {
			t.Fatalf("hostile %q: sentinel touched (err %v)", hostile, err)
		}
		if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
			t.Fatalf("hostile %q: legacy id path not evicted (err %v)", hostile, err)
		}
	}
}

// TestCleanupRemovesRealStoragePath covers the anacrolix layout: bytes live
// under dataDir/<torrent name>, not dataDir/<infohash>. Eviction must delete
// the name path (and the legacy id path) with the real dirSizeWalk.
func TestCleanupRemovesRealStoragePath(t *testing.T) {
	now := time.Now()
	m, fc := newTestManager(t)
	id, err := m.Add(testMagnet)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	fc.releaseInfo()
	namePath := filepath.Join(m.dataDir, "video.mp4")
	if err := os.MkdirAll(namePath, 0o755); err != nil {
		t.Fatalf("mkdir name path: %v", err)
	}
	if err := os.WriteFile(filepath.Join(namePath, "video.mp4"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write name path file: %v", err)
	}
	legacyPath := filepath.Join(m.dataDir, id)
	if err := os.MkdirAll(legacyPath, 0o755); err != nil {
		t.Fatalf("mkdir legacy path: %v", err)
	}
	m.setLastUsed(id, now.Add(-25*time.Hour))
	removed := m.RunCleanup(func() time.Time { return now }, 24*time.Hour, 1<<62)
	if len(removed) != 1 || removed[0] != id {
		t.Fatalf("removed %v", removed)
	}
	for _, p := range []string{namePath, legacyPath} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("storage path not evicted: %v (err %v)", p, err)
		}
	}
}

func writeFiles(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		p := filepath.Join(dir, n)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestRemoveOrphansKeepsLiveTorrentsAndClientState(t *testing.T) {
	m, fc := newTestManager(t)
	id, err := m.Add(testMagnetA)
	if err != nil {
		t.Fatal(err)
	}
	fc.releaseInfo()
	waitState(t, m, id, "ready") // fake torrent name: video.mp4
	dir := m.dataDir
	writeFiles(t, dir, "video.mp4", "Old.Movie.2019/old.mkv", ".torrent.db", ".torrent.db-wal")
	removed, err := m.RemoveOrphans()
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(removed) != "[Old.Movie.2019]" {
		t.Fatalf("removed %v", removed)
	}
	if got := fmt.Sprint(listDir(t, dir)); got != "[.torrent.db .torrent.db-wal video.mp4]" {
		t.Fatalf("left %s", got)
	}
}

func TestClearAllDropsEverythingButClientState(t *testing.T) {
	m, fc := newTestManager(t)
	for _, mag := range []string{testMagnetA, testMagnetB} {
		if _, err := m.Add(mag); err != nil {
			t.Fatal(err)
		}
	}
	fc.releaseInfo()
	writeFiles(t, m.dataDir, "video.mp4", "Other/x.mkv", ".torrent.db")
	n, err := m.ClearAll()
	if err != nil || n != 2 {
		t.Fatalf("ClearAll = %d, %v", n, err)
	}
	if got := fmt.Sprint(listDir(t, m.dataDir)); got != "[.torrent.db]" {
		t.Fatalf("left %s", got)
	}
	m.mu.Lock()
	left := len(m.byID)
	m.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d torrents still registered", left)
	}
}
