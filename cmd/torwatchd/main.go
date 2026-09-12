package main

import (
	"flag"
	"log"
	"net/http"
	"torwatch/internal/server"
	"torwatch/internal/torrents"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "static", "static files dir")
	dataDir := flag.String("data", "data", "torrent data dir")
	flag.Parse()
	m, err := torrents.NewManager(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	defer m.Close()
	log.Fatal(http.ListenAndServe(*addr, server.New(*staticDir, m)))
}
