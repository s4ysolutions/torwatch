package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torwatch/internal/torrents"
)

func TestOpensubsDisabled(t *testing.T) {
	srv, _ := newServerWithManager(t) // no API key
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs?query=movie", nil))
	if r.Code != 501 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}

func TestOpensubsProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Api-Key") != "test-key" {
			http.Error(w, "bad key", http.StatusUnauthorized)
			return
		}
		if !strings.Contains(r.URL.RawQuery, "query=") {
			http.Error(w, "bad query", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"attributes":{"file_name":"Movie.srt","language":"en","url":"https://dl.example/s.srt"}}]}`))
	}))
	defer upstream.Close()

	m, err := torrents.NewManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(m.Close)
	srv := New(t.TempDir(), m, Opts{OpensubsKey: "test-key"})
	srv.opensubsBase = upstream.URL

	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs?query=movie", nil))
	if r.Code != 200 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
	body := r.Body.String()
	for _, want := range []string{`"fileName":"Movie.srt"`, `"language":"en"`, `"downloadUrl":"https://dl.example/s.srt"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s in %q", want, body)
		}
	}
}
