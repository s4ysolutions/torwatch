package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"torwatch/internal/server"
	"torwatch/internal/torrents"
)

// parseBytes parses "20GB", "512MB", "1024" into bytes.
func parseBytes(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToUpper(s))
	mult := int64(1)
	for _, suf := range []struct {
		suffix string
		mult   int64
	}{
		{"TB", 1 << 40}, {"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10},
		{"T", 1 << 40}, {"G", 1 << 30}, {"M", 1 << 20}, {"K", 1 << 10},
		{"B", 1},
	} {
		if strings.HasSuffix(s, suf.suffix) {
			mult = suf.mult
			s = strings.TrimSuffix(s, suf.suffix)
			break
		}
	}
	s = strings.TrimSpace(s)
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("bad size %q", s)
	}
	return int64(f * float64(mult)), nil
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "static", "static files dir")
	dataDir := flag.String("data", "data", "torrent data dir")
	ttl := flag.Duration("ttl", 24*time.Hour, "idle TTL before a torrent is evicted")
	maxDiskStr := flag.String("max-disk", "20GB", "disk budget for data dir (e.g. 20GB, 512MB)")
	flag.Parse()
	maxDisk, err := parseBytes(*maxDiskStr)
	if err != nil {
		log.Fatalf("bad -max-disk: %v", err)
	}
	m, err := torrents.NewManager(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	defer m.Close()
	go m.StartCleanup(context.Background(), *ttl, maxDisk, 10*time.Minute)
	log.Fatal(http.ListenAndServe(*addr, server.New(*staticDir, m)))
}
