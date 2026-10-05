package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"torwatch/internal/torrents"
)

// fileManager is the Manager surface the HTTP layer needs (fakeable in tests).
type fileManager interface {
	Add(magnet string) (string, error)
	AddTorrentFile(data []byte) (string, error)
	Remove(id string) error
	Info(id string) (torrents.MagnetInfo, error)
	FileReader(ctx context.Context, id string, index int) (io.ReadSeekCloser, int64, error)
}

// Opts configures optional Server integrations.
type Opts struct {
	OpensubsKey string
	// Auth "user:password" puts everything except /api/health behind HTTP
	// Basic auth (the browser prompts once; <video> and fetch reuse it).
	// Empty = open server.
	Auth string
}

// Server is the HTTP handler.
type Server struct {
	mgr          fileManager
	h            http.Handler
	opensubsKey  string
	opensubsBase string
	httpClient   *http.Client
	// tests serve the temporary download link over plain http
	allowHTTPLinks bool
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.h.ServeHTTP(w, r) }

// New builds the HTTP handler. m may be nil (health/static/opensubs-disabled still work).
func New(staticDir string, m *torrents.Manager, opts Opts) *Server {
	var fm fileManager
	if m != nil {
		fm = m
	}
	return newServer(staticDir, fm, opts)
}

func newServer(staticDir string, m fileManager, opts Opts) *Server {
	s := &Server{
		mgr:          m,
		opensubsKey:  opts.OpensubsKey,
		opensubsBase: "https://api.opensubtitles.com",
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /api/opensubs", s.handleOpensubs)
	if m != nil {
		mux.HandleFunc("POST /api/magnets", func(w http.ResponseWriter, r *http.Request) {
			const maxMagnetBody = 4 << 10 // 4 KB, like the torrent-upload path
			body, err := io.ReadAll(io.LimitReader(r.Body, maxMagnetBody+1))
			if err != nil || len(body) == 0 {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if len(body) > maxMagnetBody {
				http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
				return
			}
			var req struct {
				Magnet string `json:"magnet"`
			}
			if err := json.Unmarshal(body, &req); err != nil || req.Magnet == "" {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			id, err := m.Add(req.Magnet)
			if err != nil {
				http.Error(w, "bad magnet", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"id": id})
		})
		mux.HandleFunc("GET /api/magnets/{id}", func(w http.ResponseWriter, r *http.Request) {
			info, err := m.Info(r.PathValue("id"))
			if err != nil {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(info)
		})
		mux.HandleFunc("DELETE /api/magnets/{id}", func(w http.ResponseWriter, r *http.Request) {
			if err := m.Remove(r.PathValue("id")); err != nil {
				if errors.Is(err, torrents.ErrNotFound) {
					http.Error(w, "not found", http.StatusNotFound)
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("POST /api/torrents", func(w http.ResponseWriter, r *http.Request) {
			const maxTorrentSize = 10 << 20 // 10 MB
			data, err := io.ReadAll(io.LimitReader(r.Body, maxTorrentSize+1))
			if err != nil || len(data) == 0 {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if len(data) > maxTorrentSize {
				http.Error(w, "torrent too large", http.StatusRequestEntityTooLarge)
				return
			}
			id, err := m.AddTorrentFile(data)
			if err != nil {
				http.Error(w, "bad torrent", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"id": id})
		})
		mux.HandleFunc("GET /api/magnets/{id}/files/{index}", s.handleStream)
	}
	mux.HandleFunc("GET /api/opensubs/download", s.handleOpensubsDownload)
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	s.h = withBasicAuth(opts.Auth, mux)
	return s
}

func withBasicAuth(cred string, next http.Handler) http.Handler {
	if cred == "" {
		return next
	}
	user, pass, _ := strings.Cut(cred, ":")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(user)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="torwatch", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
