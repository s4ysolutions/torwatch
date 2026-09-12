package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHealth(t *testing.T) {
	h := New(t.TempDir())
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
	h := New(dir)
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/", nil))
	if r.Code != http.StatusOK || r.Body.String() != "hi" {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}
