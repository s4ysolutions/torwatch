package server

import "net/http"

func New(staticDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	return mux
}
