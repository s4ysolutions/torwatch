#!/bin/sh
# Cross-compile torwatchd for linux/arm64 and stage a deploy tree.
#
# Usage:
#   sh deploy/build-arm64.sh              # stages into ./dist
#   DESTDIR=/tmp/tw sh deploy/build-arm64.sh
#
# Layout produced in $DESTDIR:
#   torwatchd   the arm64 daemon (service ExecStart points here via /opt/torwatch)
#   static/     web UI copy (service -static flag points here via /opt/torwatch)
set -eu
cd "$(dirname "$0")/.."
DESTDIR=${DESTDIR:-./dist}
mkdir -p "$DESTDIR"
GOOS=linux GOARCH=arm64 go build -o "$DESTDIR/torwatchd" ./cmd/torwatchd
mkdir -p "$DESTDIR/static"
cp -r static/. "$DESTDIR/static/"
echo "staged in $DESTDIR: $(ls "$DESTDIR")"
