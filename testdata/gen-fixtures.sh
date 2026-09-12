#!/bin/sh
# requires ffmpeg
set -e
cd "$(dirname "$0")"
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart simple.mp4
printf '1\n00:00:00,000 --> 00:00:01,500\nHello fixture\n' > subs.srt
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 \
  -f lavfi -i sine=frequency=440:duration=2 -f lavfi -i sine=frequency=880:duration=2 \
  -f srt -i subs.srt \
  -map 0:v -map 1:a -map 2:a -map 3:s \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -c:s srt twoaudio.mkv
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=2 \
  -c:v mpeg2video -c:a ac3 unsupported.mkv
rm subs.srt
