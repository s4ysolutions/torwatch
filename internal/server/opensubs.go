package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// OpenSubtitles requires a User-Agent naming the app; requests without
// one are rejected.
const opensubsUserAgent = "torwatch v1.0"

// Subtitle files are small; cap what the proxy relays.
const maxSubtitleBytes = 5 << 20

type subsResult struct {
	FileName    string `json:"fileName"`
	Language    string `json:"language"`
	DownloadURL string `json:"downloadUrl"`
}

// upstreamSubs mirrors the OpenSubtitles search response subset we need:
// {"data":[{"attributes":{"language","release","files":[{"file_id","file_name"}]}}]}.
// attributes.url is the subtitle's web page, not a file — downloads go
// through POST /api/v1/download with a file_id.
type upstreamSubs struct {
	Data []struct {
		Attributes struct {
			Language string `json:"language"`
			Release  string `json:"release"`
			Files    []struct {
				FileID   int64  `json:"file_id"`
				FileName string `json:"file_name"`
			} `json:"files"`
		} `json:"attributes"`
	} `json:"data"`
}

func (s *Server) client() *http.Client {
	if s.httpClient != nil {
		return s.httpClient
	}
	return http.DefaultClient
}

func (s *Server) opensubsRequest(method, path string, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, s.opensubsBase+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Api-Key", s.opensubsKey)
	req.Header.Set("User-Agent", opensubsUserAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return s.client().Do(req)
}

func upstreamError(w http.ResponseWriter) {
	http.Error(w, `{"error":"upstream"}`, http.StatusBadGateway)
}

func (s *Server) handleOpensubs(w http.ResponseWriter, r *http.Request) {
	if s.opensubsKey == "" {
		http.Error(w, `{"error":"opensubtitles not configured"}`, http.StatusNotImplemented)
		return
	}
	q := r.URL.Query().Get("query")
	resp, err := s.opensubsRequest("GET", "/api/v1/subtitles?query="+url.QueryEscape(q), nil)
	if err != nil {
		upstreamError(w)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		upstreamError(w)
		return
	}
	var up upstreamSubs
	if err := json.NewDecoder(resp.Body).Decode(&up); err != nil {
		upstreamError(w)
		return
	}
	results := make([]subsResult, 0, len(up.Data))
	for _, d := range up.Data {
		for _, f := range d.Attributes.Files {
			name := f.FileName
			if name == "" {
				name = d.Attributes.Release
			}
			results = append(results, subsResult{
				FileName:    name,
				Language:    d.Attributes.Language,
				DownloadURL: "/api/opensubs/download?file_id=" + strconv.FormatInt(f.FileID, 10),
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"results": results})
}

// handleOpensubsDownload resolves file_id to a temporary link
// (POST /api/v1/download) and relays the subtitle text, so the browser
// never needs the API key or a cross-origin fetch.
func (s *Server) handleOpensubsDownload(w http.ResponseWriter, r *http.Request) {
	if s.opensubsKey == "" {
		http.Error(w, `{"error":"opensubtitles not configured"}`, http.StatusNotImplemented)
		return
	}
	id, err := strconv.ParseInt(r.URL.Query().Get("file_id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "bad file_id", http.StatusBadRequest)
		return
	}
	body, _ := json.Marshal(map[string]int64{"file_id": id})
	resp, err := s.opensubsRequest("POST", "/api/v1/download", body)
	if err != nil {
		upstreamError(w)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 406 = daily download quota exhausted for this key.
		http.Error(w, fmt.Sprintf(`{"error":"upstream %d"}`, resp.StatusCode), http.StatusBadGateway)
		return
	}
	var dl struct {
		Link string `json:"link"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&dl); err != nil {
		upstreamError(w)
		return
	}
	link, err := url.Parse(dl.Link)
	if err != nil || (link.Scheme != "https" && !s.allowHTTPLinks) || link.Host == "" {
		upstreamError(w)
		return
	}
	fresp, err := s.client().Get(link.String())
	if err != nil {
		upstreamError(w)
		return
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		upstreamError(w)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, io.LimitReader(fresp.Body, maxSubtitleBytes))
}
