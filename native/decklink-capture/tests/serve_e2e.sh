#!/bin/sh
# Hardware-free checks of service mode (--serve, issue #95): N consumers on FIFOs, each with its own bounded queue.
# usage: sh tests/serve_e2e.sh build/camcontrol-capture   (ffmpeg/ffprobe from BROADCAST_FFMPEG or PATH; skipped if absent)
set -u
BIN=${1:?path to camcontrol-capture}
FFMPEG=${BROADCAST_FFMPEG:-$(command -v ffmpeg || true)}
FFPROBE=${BROADCAST_FFPROBE:-$(command -v ffprobe || true)}
if [ -z "$FFMPEG" ] || [ -z "$FFPROBE" ]; then echo "skip ffmpeg/ffprobe not found: service-mode checks skipped"; exit 0; fi
TMP=$(mktemp -d "${TMPDIR:-/tmp}/capture-serve.XXXXXX"); trap 'exec 3>&- 2>/dev/null; pkill -KILL -f "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
fail=0
ok()   { printf 'ok   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fail=1; }
frames() { "$FFPROBE" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$1" 2>/dev/null || echo 0; }
within() { [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; }
consumer() { mkfifo "$TMP/$1.fifo"; "$FFMPEG" -hide_banner -nostdin -v error -f matroska -i "$TMP/$1.fifo" -c copy -f matroska -y "$TMP/$1.mkv" 2>"$TMP/$1.ff" & }
serve() { mkfifo "$TMP/ctl"; "$BIN" --serve --synthetic --stall-ms 1000 "$@" <"$TMP/ctl" 2>"$TMP/h.err" & HPID=$!; exec 3>"$TMP/ctl"; }
cmd() { echo "$1" >&3; }

# 1. two consumers, one stalled: the stalled one is dropped after --stall-ms, the other keeps every frame
consumer a
mkfifo "$TMP/b.fifo"; ( exec 4<"$TMP/b.fifo"; sleep 9 ) &
serve --duration 6
cmd "attach a $TMP/a.fifo"; cmd "attach b $TMP/b.fifo"
# 2. attach c mid-run, detach it 2 s later: c ends cleanly with ~60 frames rebased to 0, a is undisturbed
sleep 2; consumer c; cmd "attach c $TMP/c.fifo"; sleep 2; cmd "detach c"
# 3. a consumer that goes away (EPIPE) is detached as "closed"; capture continues
mkfifo "$TMP/d.fifo"; ( head -c 2000000 <"$TMP/d.fifo" >/dev/null ) & cmd "attach d $TMP/d.fifo"
# 4. bad requests: not a FIFO, duplicate id, junk
: >"$TMP/plain"; cmd "attach e $TMP/plain"; cmd "attach a $TMP/a.fifo"; cmd "attach ../x /etc/passwd"
wait $HPID; rc=$?; exec 3>&-; sleep 1
[ "$rc" = 0 ] && ok "service run exits 0" || bad "service exit $rc: $(tail -c 300 "$TMP/h.err")"
n=$(frames "$TMP/a.mkv"); within "$n" 176 184 && ok "consumer a kept $n/180 frames while b stalled" || bad "consumer a frames $n"
"$FFMPEG" -v error -xerror -i "$TMP/a.mkv" -f null - 2>"$TMP/dec"; [ ! -s "$TMP/dec" ] && ok "consumer a decodes with no errors" || bad "consumer a decode errors: $(head -c 200 "$TMP/dec")"
grep -q '"event":"consumer-detached".*"id":"b".*"reason":"stalled"' "$TMP/h.err" && ok "stalled consumer b dropped as stalled" || bad "b not dropped as stalled"
grep -q '"event":"consumer-detached".*"id":"c".*"reason":"detached"' "$TMP/h.err" && ok "c detached on request" || bad "c detach event"
n=$(frames "$TMP/c.mkv"); within "$n" 50 70 && ok "c received $n frames in its 2 s" || bad "c frames $n"
start=$("$FFPROBE" -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 -read_intervals '%+#1' "$TMP/c.mkv" | head -1)
[ "$start" = "0.000000" ] && ok "late consumer c starts at pts 0" || bad "c first pts $start"
grep -q '"event":"consumer-detached".*"id":"d".*"reason":"closed"' "$TMP/h.err" && ok "vanished consumer d detached as closed" || bad "d close event"
grep -q '"consumer-attach-failed".*"id":"e".*"reason":"not-a-fifo"' "$TMP/h.err" && ok "regular file refused" || bad "not-a-fifo refusal"
grep -q '"consumer-attach-failed".*"id":"a".*"reason":"duplicate"' "$TMP/h.err" && ok "duplicate id refused" || bad "duplicate refusal"
grep -q '"event":"control-rejected"' "$TMP/h.err" && ok "malformed command rejected" || bad "junk command accepted"
grep '"type":"status"' "$TMP/h.err" | grep -q '"consumers":\[{"id":"a"' && ok "status lists per-consumer stats" || bad "consumers in status"
grep -q '"type":"exit","code":0.*"consumers_lost":2' "$TMP/h.err" && ok "exit line counts 2 lost consumers (b, d)" || bad "consumers_lost: $(grep '"type":"exit"' "$TMP/h.err")"
rm -f "$TMP"/*.fifo "$TMP/ctl"

# 5. control EOF (the app went away) stops the helper cleanly
serve; sleep 1; exec 3>&-; sleep 1.5
kill -0 "$HPID" 2>/dev/null && { bad "helper still running after control EOF"; kill -KILL "$HPID"; } || ok "control EOF stops the helper"
grep -q '"event":"control-closed"' "$TMP/h.err" && grep -q '"type":"exit","code":0' "$TMP/h.err" && ok "control-closed then exit 0" || bad "control EOF lines"
rm -f "$TMP/ctl"

# 6. format change: exit 5 with a format-changed error, consumers get end of stream
consumer f; serve --synthetic-format-change 1; cmd "attach f $TMP/f.fifo"
wait $HPID; rc=$?; exec 3>&-; sleep 1
[ "$rc" = 5 ] && grep -q '"code":"format-changed"' "$TMP/h.err" && ok "format change exits 5 with format-changed" || bad "format change rc=$rc"
pgrep -f "$TMP/f.fifo" >/dev/null && bad "consumer f still running after helper exit" || ok "consumer f ended with the helper"

[ "$fail" = 0 ] && echo "serve_e2e: all checks passed" || { echo "serve_e2e: FAILED"; exit 1; }
