package server

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"torwatch/internal/torrents"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

// testTorrentBytes is a minimal valid trackerless .torrent (single file
// test.txt, 5 bytes). Raw bencode: d4:info<info>e.
var testTorrentBytes = []byte("d4:infod6:lengthi5e4:name8:test.txt12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee")

func newServerWithManager(t *testing.T) (*Server, *torrents.Manager) {
	t.Helper()
	m, err := torrents.NewManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(m.Close)
	srv := New(t.TempDir(), m, Opts{})
	return srv, m
}

func TestDeleteMagnet(t *testing.T) {
	srv, mgr := newServerWithManager(t)
	id, err := mgr.Add(testMagnet)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("DELETE", "/api/magnets/"+id, nil))
	if r.Code != 204 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
	if _, err := mgr.Info(id); !errors.Is(err, torrents.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestDeleteMagnetNotFound(t *testing.T) {
	srv, _ := newServerWithManager(t)
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("DELETE", "/api/magnets/deadbeef", nil))
	if r.Code != 404 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestUploadTorrentFile(t *testing.T) {
	srv, _ := newServerWithManager(t)
	r := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/torrents", strings.NewReader(string(testTorrentBytes)))
	srv.ServeHTTP(r, req)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"id"`) {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestUploadTorrentFileBad(t *testing.T) {
	srv, _ := newServerWithManager(t)
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("POST", "/api/torrents", strings.NewReader("not a torrent")))
	if r.Code != 400 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}
