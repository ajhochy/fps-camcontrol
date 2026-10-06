#!/usr/bin/env bash
# Run CamControl itself as a macOS background service (a launchd LaunchAgent): it starts at login, needs no
# terminal, and comes back after a crash. The tracking helper and the Sony service follow as before (the app
# launches the tracker; the Sony service has its own agent, scripts/install-sony-service.sh).
#
#   scripts/install-app-service.sh [--home /path/with/config] [--node /path/to/node]
#   scripts/install-app-service.sh --uninstall
#
# The app runs from this checkout's dist/ (build it first: pnpm build). --home is where config/ and logs/ live
# (CAMCONTROL_HOME); it defaults to this checkout.
#
# Restart policy: a crash (non-zero exit or a signal) is restarted by launchd; a clean stop (launchctl stop or
# SIGTERM, which shuts down cleanly and exits 0) stays stopped until the next login or:
#   launchctl kickstart -k gui/$(id -u)/com.fpscamcontrol.app
# Deploy a new build the same way: pnpm build, then that kickstart command.
set -euo pipefail

LABEL="com.fpscamcontrol.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT="$HOME/Library/Application Support/fps-camcontrol"
WRAPPER="$SUPPORT/run-camcontrol.sh"
LOG_DIR="$HOME/Library/Logs/fps-camcontrol"
LOG="$LOG_DIR/camcontrol.log"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOME="$REPO"
NODE="$(command -v node || true)"
DOMAIN="gui/$(id -u)"

while [ $# -gt 0 ]; do
  case "$1" in
    --home) APP_HOME="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --uninstall)
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      rm -f "$PLIST" "$WRAPPER"
      echo "Removed the CamControl background service ($LABEL)."
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# launchd starts with a bare PATH, so pin the real node binary (not a shell shim or symlink that may move).
[ -n "$NODE" ] || { echo "node not found; pass --node /path/to/node" >&2; exit 1; }
NODE="$(realpath "$NODE")"
[ -x "$NODE" ] || { echo "node is not executable: $NODE" >&2; exit 1; }
[ -f "$REPO/dist/index.js" ] || { echo "No build at $REPO/dist/index.js; run pnpm build first." >&2; exit 1; }
[ -f "$APP_HOME/config/devices.yaml" ] || { echo "No config at $APP_HOME/config/devices.yaml" >&2; exit 1; }

PORT="$(awk '/^server:/{s=1;next} s&&/^[^ ]/{s=0} s&&/port:/{print $2; exit}' "$APP_HOME/config/devices.yaml")"
PORT="${PORT:-8080}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Something is already listening on port $PORT (probably CamControl started in a terminal)." >&2
  echo "Stop it first, then run this again." >&2
  exit 1
fi

mkdir -p "$SUPPORT" "$LOG_DIR" "$HOME/Library/LaunchAgents"

# The wrapper keeps the log from growing without bound. Developer tracking tokens are never inherited: the app
# launches and owns its tracking helper.
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
LOG="$LOG"
if [ -f "\$LOG" ] && [ "\$(stat -f %z "\$LOG")" -gt 52428800 ]; then mv -f "\$LOG" "\$LOG.1"; fi
cd "$REPO"
unset TRACKER_WS_TOKEN TRACKER_FRAME_TOKEN
export CAMCONTROL_HOME="$APP_HOME"
exec "$NODE" dist/index.js >>"\$LOG" 2>&1
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
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old app has finished its clean shutdown; bootstrapping too early fails (error 5).
for _ in $(seq 1 30); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed and started the CamControl background service ($LABEL) on port $PORT."
echo "Code: $REPO   Config: $APP_HOME/config   Log: $LOG"
