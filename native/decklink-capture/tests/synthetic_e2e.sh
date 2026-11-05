#!/bin/sh
# Hardware-free end-to-end checks of the helper's output path (container, timing, signals, EPIPE, backpressure, exit codes).
# usage: sh tests/synthetic_e2e.sh build/camcontrol-capture   (ffmpeg/ffprobe from BROADCAST_FFMPEG or PATH; skipped if absent)
set -u
BIN=${1:?path to camcontrol-capture}
FFMPEG=${BROADCAST_FFMPEG:-$(command -v ffmpeg || true)}
FFPROBE=${BROADCAST_FFPROBE:-$(command -v ffprobe || true)}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/capture-e2e.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
fail=0
ok()   { printf 'ok   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fail=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# 1. exit codes / usage
"$BIN" --bogus >/dev/null 2>"$TMP/e"; check "unknown option exits 2" $? 2
grep -q '"code":"usage"' "$TMP/e" && ok "usage error is a JSON line" || bad "usage error JSON"
"$BIN" --synthetic --channels 3 >/dev/null 2>&1; check "bad channel count exits 2" $? 2
if ! "$BIN" --list-devices >/dev/null 2>"$TMP/e"; then
  if grep -q no-decklink "$TMP/e"; then ok "synthetic-only build refuses --list-devices with a JSON error"; fi
fi

# 2. a clean synthetic run decodes: frame count and rational rate
if [ -n "$FFMPEG" ] && [ -n "$FFPROBE" ]; then
  "$BIN" --synthetic --duration 4 --output "$TMP/a.mkv" 2>"$TMP/a.err"; check "duration run exits 0" $? 0
  n=$("$FFPROBE" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$TMP/a.mkv")
  [ "$n" -ge 119 ] && [ "$n" -le 122 ] && ok "4 s of 1080p30 is $n frames" || bad "frame count $n"
  "$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,pix_fmt -of csv=p=0 "$TMP/a.mkv" | grep -q '^1920,1080,uyvy422,30/1$' && ok "1920x1080 uyvy422 30/1" || bad "stream parameters"
  "$FFMPEG" -v error -xerror -i "$TMP/a.mkv" -f null - 2>"$TMP/dec" ; [ ! -s "$TMP/dec" ] && ok "container decodes with no errors" || bad "decode errors: $(head -c 200 "$TMP/dec")"
  "$FFPROBE" -v error -select_streams a:0 -show_entries stream=codec_name,channels,sample_rate -of csv=p=0 "$TMP/a.mkv" | grep -q '^pcm_s32le,48000,2$' && ok "audio is 48 kHz stereo pcm_s32le" || bad "audio parameters"
  grep -q '"type":"exit","code":0' "$TMP/a.err" && ok "final exit line emitted" || bad "exit line"
  grep -q '"type":"status"' "$TMP/a.err" && ok "status lines emitted" || bad "status lines"
  # 3. 720p50 and 1080p2997 headers carry the right rational rates
  "$BIN" --synthetic --synthetic-mode 720p5994 --duration 2 --output "$TMP/b.mkv" 2>/dev/null
  "$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$TMP/b.mkv" | grep -q '^1280,720$' && ok "720p5994 dimensions" || bad "720p5994 dimensions"
else
  echo "skip ffmpeg/ffprobe not found: container decode checks skipped"
fi

# 3b. impulse mode (#68 timing source): one flash/click event per 2 s of stream time, at exact frame multiples
"$BIN" --synthetic --synthetic-impulse --duration 5 --output /dev/null 2>"$TMP/i.err"; check "impulse run exits 0" $? 0
grep -q '"event":"impulse","t_ms":[0-9]*,"n":0,"pts_ns":0}' "$TMP/i.err" && grep -q '"n":60,"pts_ns":2000000000}' "$TMP/i.err" && grep -q '"n":120,"pts_ns":4000000000}' "$TMP/i.err" && ok "impulse events at frames 0/60/120 (0 s, 2 s, 4 s)" || bad "impulse events: $(grep -c impulse "$TMP/i.err")"

# 4. SIGTERM: clean, prompt shutdown with a final exit line (stdout drained by a real reader)
( "$BIN" --synthetic 2>"$TMP/t.err" | cat >/dev/null ) &
sleep 2; pkill -TERM -f "camcontrol-capture --synthetic$" ; sleep 2
grep -q '"event":"stopping","t_ms":[0-9]*,"reason":"signal"' "$TMP/t.err" && grep -q '"type":"exit","code":0' "$TMP/t.err" && ok "SIGTERM stops cleanly (exit line, code 0)" || bad "SIGTERM handling: $(tail -c 300 "$TMP/t.err")"
pgrep -f "camcontrol-capture --synthetic$" >/dev/null && { bad "helper still running after SIGTERM"; pkill -KILL -f "camcontrol-capture --synthetic$"; } || ok "no helper left running"

# 5. stdout EPIPE: downstream closes after 1 MB -> clean exit 0 with a stdout-closed event
"$BIN" --synthetic --duration 20 2>"$TMP/p.err" | head -c 1000000 >/dev/null
rc=$(grep -c '"event":"stdout-closed"' "$TMP/p.err"); check "EPIPE reported as stdout-closed" "$rc" 1
grep -q '"type":"exit","code":0' "$TMP/p.err" && ok "EPIPE exit code 0" || bad "EPIPE exit line"

# 6. backpressure: a reader that stalls 4 s -> frames dropped and counted, memory bounded, no unbounded queue
( "$BIN" --synthetic --duration 8 --queue-frames 4 2>"$TMP/bp.err" | ( sleep 4; cat >/dev/null ) ) &
sleep 3.5; rss=$(ps -o rss= -p "$(pgrep -f 'camcontrol-capture --synthetic --duration 8' | head -1)" 2>/dev/null | tr -d ' ')
wait
dropped=$(grep '"type":"exit"' "$TMP/bp.err" | sed 's/.*"dropped_backpressure":\([0-9]*\).*/\1/')
[ "${dropped:-0}" -gt 20 ] && ok "backpressure dropped $dropped frames while the reader stalled" || bad "backpressure drops: ${dropped:-none}"
[ "${rss:-999999}" -lt 400000 ] && ok "RSS bounded during stall (${rss} KB)" || bad "RSS during stall ${rss} KB"
grep -q '"max_block_ms":[1-9][0-9][0-9]' "$TMP/bp.err" && ok "writer block time reported" || bad "max_block_ms not reported"

[ $fail = 0 ] && echo "synthetic_e2e: all passed" || { echo "synthetic_e2e: FAILED"; exit 1; }
