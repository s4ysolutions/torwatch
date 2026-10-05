package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"torwatch/internal/torrents"
)

type fakeFileManager struct {
	data  []byte
	err   error
	files []torrents.FileInfo
}

// nopSeekCloser is an io.ReadSeekCloser over a byte slice.
type nopSeekCloser struct{ io.ReadSeeker }

func (nopSeekCloser) Close() error { return nil }

func (f *fakeFileManager) Add(magnet string) (string, error) { return "x", nil }

func (f *fakeFileManager) AddTorrentFile(data []byte) (string, error) { return "x", nil }

func (f *fakeFileManager) Remove(id string) error { return nil }

func (f *fakeFileManager) Info(id string) (torrents.MagnetInfo, error) {
	return torrents.MagnetInfo{ID: id, Files: f.files}, nil
}

func (f *fakeFileManager) FileReader(_ context.Context, id string, index int) (io.ReadSeekCloser, int64, error) {
	if f.err != nil {
		return nil, 0, f.err
	}
	return nopSeekCloser{bytes.NewReader(f.data)}, int64(len(f.data)), nil
}

func newServerWithFakeManager(t *testing.T, data []byte) *Server {
	t.Helper()
	return newServer(t.TempDir(), &fakeFileManager{data: data}, Opts{})
}

func TestStreamFullAndRange(t *testing.T) {
	data := []byte("0123456789abcdef")
	srv := newServerWithFakeManager(t, data)

	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/magnets/x/files/0", nil))
	if r.Code != 200 || r.Body.String() != string(data) {
		t.Fatalf("full: %d", r.Code)
	}

	r = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/magnets/x/files/0", nil)
	req.Header.Set("Range", "bytes=4-9")
	srv.ServeHTTP(r, req)
	if r.Code != 206 || r.Body.String() != "456789" {
		t.Fatalf("range: %d %q", r.Code, r.Body.String())
	}
}

func TestStreamContentTypeByExtension(t *testing.T) {
	data := []byte("0123456789abcdef")
	for path, want := range map[string]string{
		"film.mp4":  "video/mp4",
		"FILM.MP4":  "video/mp4",
		"film.webm": "video/webm",
		"film.mkv":  "video/x-matroska",
		"film.avi":  "application/octet-stream",
		"film":      "application/octet-stream",
	} {
		fm := &fakeFileManager{data: data, files: []torrents.FileInfo{{Index: 0, Path: path, Size: int64(len(data))}}}
		srv := newServer(t.TempDir(), fm, Opts{})
		r := httptest.NewRecorder()
		srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/magnets/x/files/0", nil))
		if r.Code != 200 {
			t.Fatalf("%s: got %d", path, r.Code)
		}
		if got := r.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: Content-Type = %q, want %q", path, got, want)
		}
	}
}

func TestStreamUnknownMagnet(t *testing.T) {
	srv := newServer(t.TempDir(), &fakeFileManager{err: torrents.ErrNotFound}, Opts{})
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/magnets/x/files/0", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}
