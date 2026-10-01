#!/usr/bin/env bash
# Run the Sony camera service (CameraWebApp sidecar) as a macOS background service (a launchd LaunchAgent),
# so it starts at login, needs no terminal, and keeps running when CamControl restarts.
#
#   scripts/install-sony-service.sh [--executable /path/to/CameraWebApp] [--port 8181]
#   scripts/install-sony-service.sh --uninstall
#
# Restart policy: a crash (non-zero exit or a signal) is restarted by launchd; a deliberate stop through
# POST /api/server/shutdown (CamControl's "Stop Sony service" button) exits 0 and stays stopped until
# CamControl's "Start Sony service" button (launchctl kickstart) or the next login.
#
# Stop any copy you started in a terminal first: only one service can hold the port.
set -euo pipefail

LABEL="com.fpscamcontrol.sony-sidecar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT="$HOME/Library/Application Support/fps-camcontrol"
WRAPPER="$SUPPORT/run-sony-sidecar.sh"
LOG_DIR="$HOME/Library/Logs/fps-camcontrol"
LOG="$LOG_DIR/sony-sidecar.log"
EXECUTABLE="${SONY_SERVER_EXECUTABLE:-$HOME/Developer/alpha-sdk-api/api/server/build/CameraWebApp}"
PORT=8181
# Live preview frame interval for the service's live-view worker (scripts/sony-sidecar-liveview-rate.patch):
# 200 ms = 5 fps, which keeps camera Wi-Fi/processor load (and heat) down. The unpatched default is 66 ms.
LIVEVIEW_INTERVAL_MS="${LIVEVIEW_INTERVAL_MS:-200}"
DOMAIN="gui/$(id -u)"

while [ $# -gt 0 ]; do
  case "$1" in
    --executable) EXECUTABLE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --uninstall)
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      rm -f "$PLIST" "$WRAPPER"
      echo "Removed the Sony background service ($LABEL)."
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -x "$EXECUTABLE" ] || { echo "Sony service executable not found or not executable: $EXECUTABLE" >&2; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Something is already listening on port $PORT (probably the Sony service started in a terminal)." >&2
  echo "Stop it first (Ctrl+C in that terminal), then run this again." >&2
  exit 1
fi

mkdir -p "$SUPPORT" "$LOG_DIR" "$HOME/Library/LaunchAgents"

# The wrapper keeps the log from growing without bound (the service logs every preview frame).
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
LOG="$LOG"
if [ -f "\$LOG" ] && [ "\$(stat -f %z "\$LOG")" -gt 52428800 ]; then mv -f "\$LOG" "\$LOG.1"; fi
cd "$(dirname "$EXECUTABLE")"
export LIVEVIEW_INTERVAL_MS="$LIVEVIEW_INTERVAL_MS"
exec "$EXECUTABLE" --port "$PORT" >>"\$LOG" 2>&1
EOF
chmod +x "$WRAPPER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$WRAPPER</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash; stay stopped after a deliberate, clean stop (exit 0). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old service has finished its clean shutdown; bootstrapping too early fails (error 5).
for _ in $(seq 1 30); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed and started the Sony background service ($LABEL) on port $PORT."
echo "Log: $LOG"
echo "CamControl adopts it automatically. Set sony.launchdLabel: $LABEL in config/devices.yaml so its Start button works."
