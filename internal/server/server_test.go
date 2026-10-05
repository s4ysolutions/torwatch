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

func TestBasicAuthGuardsAllButHealth(t *testing.T) {
	srv := newServer(t.TempDir(), &fakeFileManager{data: []byte("x")}, Opts{Auth: "u:p4ss"})
	cases := []struct {
		path       string
		user, pass string
		want       int
	}{
		{"/api/health", "", "", 200},
		{"/api/magnets/x/files/0", "", "", 401},
		{"/", "", "", 401},
		{"/api/magnets/x/files/0", "u", "wrong", 401},
		{"/api/magnets/x/files/0", "u", "p4ss", 200},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", c.path, nil)
		if c.user != "" {
			req.SetBasicAuth(c.user, c.pass)
		}
		r := httptest.NewRecorder()
		srv.ServeHTTP(r, req)
		if r.Code != c.want {
			t.Fatalf("%s as %q: got %d want %d", c.path, c.user, r.Code, c.want)
		}
		if c.want == 401 && r.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: 401 without challenge", c.path)
		}
	}
}

func TestStaticFilesRevalidate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := newServer(dir, nil, Opts{})
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/app.js", nil))
	if r.Code != 200 || r.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("got %d Cache-Control=%q", r.Code, r.Header().Get("Cache-Control"))
	}
}
