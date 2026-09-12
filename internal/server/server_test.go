package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"torwatch/internal/torrents"
)

func TestHealth(t *testing.T) {
	h := New(t.TempDir(), nil, Opts{})
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/api/health", nil))
	if r.Code != http.StatusOK || r.Body.String() != `{"ok":true}` {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestStaticIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := New(dir, nil, Opts{})
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/", nil))
	if r.Code != http.StatusOK || r.Body.String() != "hi" {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestPostMagnetBodyLimit(t *testing.T) {
	srv := newServer(t.TempDir(), &fakeFileManager{data: []byte("x")}, Opts{})
	// Oversize body → 413.
	big := `{"magnet":"magnet:?xt=urn:btih:` + strings.Repeat("a", 8<<10) + `"}`
	r := httptest.NewRecorder()
	huge := httptest.NewRequest("POST", "/api/magnets", strings.NewReader(big))
	srv.ServeHTTP(r, huge)
	if r.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: got %d %q", r.Code, r.Body.String())
	}
	// Small valid body still works.
	r = httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("POST", "/api/magnets", strings.NewReader(`{"magnet":"magnet:?xt=urn:btih:abc"}`)))
	if r.Code != http.StatusOK {
		t.Fatalf("valid: got %d %q", r.Code, r.Body.String())
	}
}

func TestPostMagnetBad(t *testing.T) {
	m := torrents.NewManagerWithClient(nil, t.TempDir())
	h := New(t.TempDir(), m, Opts{})
	r := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/magnets", strings.NewReader(`{"magnet":"not-a-magnet"}`))
	h.ServeHTTP(r, req)
	if r.Code != http.StatusBadRequest {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestGetMagnetNotFound(t *testing.T) {
	m := torrents.NewManagerWithClient(nil, t.TempDir())
	h := New(t.TempDir(), m, Opts{})
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/api/magnets/deadbeef", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}
