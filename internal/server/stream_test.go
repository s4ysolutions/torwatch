package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"torwatch/internal/torrents"
)

type fakeFileManager struct {
	data []byte
	err  error
}

// nopSeekCloser is an io.ReadSeekCloser over a byte slice.
type nopSeekCloser struct{ io.ReadSeeker }

func (nopSeekCloser) Close() error { return nil }

func (f *fakeFileManager) Add(magnet string) (string, error) { return "x", nil }

func (f *fakeFileManager) AddTorrentFile(data []byte) (string, error) { return "x", nil }

func (f *fakeFileManager) Remove(id string) error { return nil }

func (f *fakeFileManager) Info(id string) (torrents.MagnetInfo, error) {
	return torrents.MagnetInfo{ID: id}, nil
}

func (f *fakeFileManager) FileReader(id string, index int) (io.ReadSeekCloser, int64, error) {
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

func TestStreamUnknownMagnet(t *testing.T) {
	srv := newServer(t.TempDir(), &fakeFileManager{err: torrents.ErrNotFound}, Opts{})
	r := httptest.NewRecorder()
	srv.ServeHTTP(r, httptest.NewRequest("GET", "/api/magnets/x/files/0", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("got %d %q", r.Code, r.Body.String())
	}
}
