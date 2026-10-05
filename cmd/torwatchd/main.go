package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
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
	n := int64(f * float64(mult))
	if n <= 0 {
		return 0, fmt.Errorf("bad size %q: must be positive", s)
	}
	return n, nil
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "static", "static files dir")
	dataDir := flag.String("data", "data", "torrent data dir")
	ttl := flag.Duration("ttl", 24*time.Hour, "idle TTL before a torrent is evicted")
	maxDiskStr := flag.String("max-disk", "20GB", "disk budget for data dir (e.g. 20GB, 512MB)")
	upload := flag.Bool("upload", false, "upload to peers while downloading (off: leech only)")
	peerPort := flag.Int("peer-port", 0, "BitTorrent listen port (0 = 42069)")
	metaTimeout := flag.Duration("meta-timeout", torrents.DefaultMetaTimeout, "give up on a torrent without metadata after this long")
	flag.Parse()
	maxDisk, err := parseBytes(*maxDiskStr)
	if err != nil {
		log.Fatalf("bad -max-disk: %v", err)
	}
	if err := run(*addr, *staticDir, *dataDir, *ttl, maxDisk, torrents.Options{
		Upload:      *upload,
		ListenPort:  *peerPort,
		MetaTimeout: *metaTimeout,
	}); err != nil {
		log.Fatal(err)
	}
}

// run serves until SIGINT/SIGTERM, then drains HTTP and closes the torrent
// client (so it can flush state and release its port).
func run(addr, staticDir, dataDir string, ttl time.Duration, maxDisk int64, opts torrents.Options) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	m, err := torrents.NewManager(dataDir, opts)
	if err != nil {
		return err
	}
	defer m.Close()
	go m.StartCleanup(ctx, ttl, maxDisk, 10*time.Minute)
	srv := &http.Server{
		Addr: addr,
		Handler: server.New(staticDir, m, server.Opts{
			OpensubsKey: os.Getenv("OPENSUBTITLES_API_KEY"),
			Auth:        os.Getenv("TORWATCH_AUTH"), // "user:password"; empty = open
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No WriteTimeout: video responses stream for as long as playback.
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Print("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutCtx)
}
