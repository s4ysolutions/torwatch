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
# AC-3 5.1 + E-AC-3 stereo + AAC: passthrough / per-track playability.
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 \
  -f lavfi -i sine=frequency=440:duration=2 -f lavfi -i sine=frequency=660:duration=2 \
  -f lavfi -i sine=frequency=880:duration=2 \
  -map 0:v -map 1:a -map 2:a -map 3:a \
  -c:v libx264 -pix_fmt yuv420p \
  -c:a:0 ac3 -ac:a:0 6 -b:a:0 192k -c:a:1 eac3 -ac:a:1 2 -c:a:2 aac \
  -metadata:s:a:0 language=rus -metadata:s:a:1 language=ukr -metadata:s:a:2 language=eng ac3mix.mkv
# 20s, keyframe every 2s, 2s clusters, Cues index: seeking.
ffmpeg -y -f lavfi -i testsrc=duration=20:size=160x120:rate=10 -f lavfi -i sine=frequency=440:duration=20 \
  -c:v libx264 -pix_fmt yuv420p -b:v 100k -g 20 -c:a aac -b:a 32k -cluster_time_limit 2000 seek.mkv
rm subs.srt
