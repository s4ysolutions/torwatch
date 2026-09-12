package server

import (
	"encoding/json"
	"net/http"

	"torwatch/internal/torrents"
)

// New builds the HTTP handler. m may be nil (health/static still work).
func New(staticDir string, m *torrents.Manager) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	if m != nil {
		mux.HandleFunc("POST /api/magnets", func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				Magnet string `json:"magnet"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Magnet == "" {
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
	}
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	return mux
}
