package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"torwatch/internal/torrents"
)

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
	rs, _, err := s.mgr.FileReader(id, idx)
	if errors.Is(err, torrents.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rs.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", time.Time{}, rs)
}
