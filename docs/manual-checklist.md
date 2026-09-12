# torwatch manual checklist

Build under test: `torwatchd-linux-arm64` (see `deploy/build-arm64.sh`)
or local `go run ./cmd/torwatchd`. Defaults: `-addr :8080 -static static
-data data -ttl 24h -max-disk 20GB` (see `cmd/torwatchd/main.go`).

## Core cases (per plan)

### 1. MP4 magnet plays via native player, subs upload works
1. Open app, paste MP4 magnet, submit.
2. Expect: native `<video>` playback starts, no transcode error.
3. Upload an `.srt` file via subtitles widget.
4. Expect: uploaded track listed, selectable, cues render.

### 2. MKV (2 audio + embedded subs) plays via MSE, audio switch, subs
1. Paste MKV magnet (2 audio tracks + embedded subs), submit.
2. Expect: MSE player used, video plays.
3. Switch audio track via tracks menu.
4. Expect: audio changes, playback continues.
5. Expect: embedded subs listed in widget, active cue highlights,
   copy button works.

### 3. Unsupported codec errors with download link
1. Paste magnet with unsupported video codec, submit.
2. Expect: clear error state, stream does not hang.
3. Expect: download link offered for the file.

### 4. Reload mid-play hits OPFS, restores position
1. Start playback on any torrent, seek to mid-point, wait for progress.
2. Reload the page.
3. Expect: OPFS cache hit (no full re-download), playback position restored.

### 5. Stalled torrent shows "waiting for peers"
1. Paste magnet with no peers, submit.
2. Wait 60 s.
3. Expect: status shows "waiting for peers" (not spinner forever, no crash).

### 6. TTL eviction (with `-ttl 1m`)
1. Start server with `-ttl 1m`, load a torrent, stop activity.
2. Wait > 1 min (+ 10-min cleanup ticker may apply — see note).
3. Expect: idle torrent file evicted from data dir.
   Note: backend cleanup ticker runs every 10 min
   (`StartCleanup(..., 10*time.Minute)`), so for a fast manual check
   either wait for the ticker or restart with a short TTL and verify
   expiry logic via logs.

### 7. OpenSubtitles search with/without key
1. With `OPENSUBTITLES_API_KEY` set: use Find-online/subtitle search.
2. Expect: results listed, download works.
3. Without key: repeat search.
4. Expect: HTTP 501 with clear "not configured" message.

## Deferred manual coverage (from prior reviews)

### 8. Single-arg view forms (inputCard / statusBar / downloadsRow)
1. Render each view with a single element/string argument
   (not a props object).
2. Expect: inputCard, statusBar, downloadsRow each resolve the element
   path correctly (no crash, correct DOM output).

### 9. Grip-drag resize + persistence
1. Drag the subtitles-widget grip to resize.
2. Reload the page.
3. Expect: new size persists (localStorage), layout intact.

### 10. Clipboard copy-all
1. In subtitles widget, click copy-all.
2. Expect: full subtitle text on clipboard, success feedback shown.

### 11. Find-online flow
1. With API key configured, run Find-online for current video.
2. Expect: search runs, results render, selecting one loads subtitles.

### 12. Deep-link `#/play/…` before ready
1. Open `#/play/<id>` directly in a fresh tab before app ready
   (cold load / slow network).
2. Expect: app waits for readiness, then resolves and plays —
   no blank page, no premature "not found".

### 13. Duplicate-id check
1. Submit the same magnet/infohash twice.
2. Expect: single entry reused (no duplicate torrent instance),
   UI reflects existing item.

### 14. Seek-before-sourceopen
1. Immediately seek after submitting magnet, before MSE SourceOpen.
2. Expect: seek deferred/queued, applied once source opens —
   no exception, playback starts at requested position.

### 15. Short-content tail flush (2 s clip plays to end)
1. Load a ~2 s clip via MSE path.
2. Play to end.
3. Expect: tail flushed via `endOfStream`, playback reaches `ended`
   (does not stall on last fragment).
