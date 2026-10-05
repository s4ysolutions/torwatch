package server

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"torwatch/internal/torrents"
)

// contentTypeFor sniffs the MIME type from the torrent file path so native
// <video src> works on strict browsers; unknown extensions stay generic.
func contentTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	default:
		return "application/octet-stream"
	}
}

// handleStream serves a torrent file with Range/206 support via
// http.ServeContent. The anacrolix Reader prioritizes pieces near the read
// offset automatically, so playback starts without the full file.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	idx, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	rs, _, err := s.mgr.FileReader(r.Context(), id, idx)
	if errors.Is(err, torrents.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rs.Close()
	ctype := "application/octet-stream"
	if info, err := s.mgr.Info(id); err == nil {
		for _, f := range info.Files {
			if f.Index == idx {
				ctype = contentTypeFor(f.Path)
				break
			}
		}
	}
	w.Header().Set("Content-Type", ctype)
	http.ServeContent(w, r, "", time.Time{}, rs)
}
