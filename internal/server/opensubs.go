package server

import (
	"encoding/json"
	"net/http"
	"net/url"
)

type subsResult struct {
	FileName    string `json:"fileName"`
	Language    string `json:"language"`
	DownloadURL string `json:"downloadUrl"`
}

// upstreamSubs mirrors the OpenSubtitles search response subset we need:
// {"data":[{"attributes":{"file_name","language","url"}}]}.
type upstreamSubs struct {
	Data []struct {
		Attributes struct {
			FileName string `json:"file_name"`
			Language string `json:"language"`
			URL      string `json:"url"`
		} `json:"attributes"`
	} `json:"data"`
}

func (s *Server) handleOpensubs(w http.ResponseWriter, r *http.Request) {
	if s.opensubsKey == "" {
		http.Error(w, `{"error":"opensubtitles not configured"}`, http.StatusNotImplemented)
		return
	}
	q := r.URL.Query().Get("query")
	upstream := s.opensubsBase + "/api/v1/subtitles?query=" + url.QueryEscape(q)
	req, err := http.NewRequest("GET", upstream, nil)
	if err != nil {
		http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
		return
	}
	req.Header.Set("Api-Key", s.opensubsKey)
	client := s.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
		return
	}
	var up upstreamSubs
	if err := json.NewDecoder(resp.Body).Decode(&up); err != nil {
		http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
		return
	}
	results := make([]subsResult, 0, len(up.Data))
	for _, d := range up.Data {
		results = append(results, subsResult{
			FileName:    d.Attributes.FileName,
			Language:    d.Attributes.Language,
			DownloadURL: d.Attributes.URL,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"results": results})
}
