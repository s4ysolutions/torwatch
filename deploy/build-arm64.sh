#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
GOOS=linux GOARCH=arm64 go build -o torwatchd-linux-arm64 ./cmd/torwatchd
