package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The opensubs routes need no torrent manager.
func newOpensubsServer(t *testing.T, key, base string) *Server {
	t.Helper()
	srv := newServer(t.TempDir(), nil, Opts{OpensubsKey: key})
	srv.opensubsBase = base
	srv.allowHTTPLinks = true
	return srv
}

func TestOpensubsDisabled(t *testing.T) {
	srv := newOpensubsServer(t, "", "")
	for _, path := range []string{"/api/opensubs?query=movie", "/api/opensubs/download?file_id=1"} {
		r := httptest.NewRecorder()
		srv.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 501 {
			t.Fatalf("%s: got %d %q", path, r.Code, r.Body.String())
		}
	}
}

// fakeOpensubs mimics search, download-link and file endpoints, checking
// the headers OpenSubtitles requires.
func fakeOpensubs(t *testing.T) *httptest.Server {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/files/42.srt" {
			io.WriteString(w, "1\n00:00:01,000 --> 00:00:02,000\nHi\n")
			return
		}
		if r.Header.Get("Api-Key") != "test-key" || r.Header.Get("User-Agent") == "" {
			http.Error(w, "bad key or user agent", http.StatusForbidden)
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/subtitles":
			w.Write([]byte(`{"data":[{"attributes":{"language":"en","release":"Movie.2020",` +
				`"url":"https://www.opensubtitles.com/en/subtitles/movie",` +
				`"files":[{"file_id":42,"file_name":"Movie.srt"}]}}]}`))
		case r.Method == "POST" && r.URL.Path == "/api/v1/download":
			var body struct {
				FileID int64 `json:"file_id"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.FileID != 42 {
				http.Error(w, "bad file", http.StatusNotFound)
				return
			}
			w.Write([]byte(`{"link":"` + srv.URL + `/files/42.srt","remaining":4}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestOpensubsSearchReturnsProxyDownloadURL(t *testing.T) {
	up := fakeOpensubs(t)
	srv := newOpensubsServer(t, "test-key", up.URL)
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs?query=movie", nil))
	if r.Code != 200 {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
	body := r.Body.String()
	for _, want := range []string{`"fileName":"Movie.srt"`, `"language":"en"`, `"downloadUrl":"/api/opensubs/download?file_id=42"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s in %q", want, body)
		}
	}
}

func TestOpensubsDownloadRelaysSubtitleText(t *testing.T) {
	up := fakeOpensubs(t)
	srv := newOpensubsServer(t, "test-key", up.URL)
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs/download?file_id=42", nil))
	if r.Code != 200 || !strings.Contains(r.Body.String(), "00:00:01,000 --> 00:00:02,000") {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
	for _, bad := range []string{"", "abc", "-1"} {
		r = httptest.NewRecorder()
		srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs/download?file_id="+bad, nil))
		if r.Code != 400 {
			t.Fatalf("file_id=%q: got %d", bad, r.Code)
		}
	}
	r = httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/opensubs/download?file_id=7", nil))
	if r.Code != 502 {
		t.Fatalf("unknown file: got %d", r.Code)
	}
}
