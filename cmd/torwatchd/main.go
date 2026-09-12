package main

import (
	"flag"
	"log"
	"net/http"
	"torwatch/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "static", "static files dir")
	flag.Parse()
	log.Fatal(http.ListenAndServe(*addr, server.New(*staticDir)))
}
