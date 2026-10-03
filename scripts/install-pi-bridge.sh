#!/usr/bin/env bash
# Install (or update) the DJI gimbal bridge on a Raspberry Pi, run FROM THIS MAC over SSH.
#
#   scripts/install-pi-bridge.sh <host> [options]
#
#   --user NAME        SSH / service account on the Pi (default: pi)
#   --user-service     install as a systemd USER service (no sudo needed; needs lingering for start at boot)
#   --system           install as a system unit (/etc/systemd/system/dji-bridge.service; needs passwordless sudo)
#                      Default: --system when `sudo -n true` works on the Pi, otherwise --user-service.
#   --gimbal ADDR      save ADDR (AA:BB:CC:DD:EE:FF) as the gimbal this bridge drives (gimbal.json), so it never
#                      has to guess. Without it, an existing choice is kept; a fresh Pi picks the strongest DJI gimbal.
#   --dir DIR          install directory on the Pi (default: ~/dji-bridge)
#   --wifi-off         turn Wi-Fi off, only if the Pi is on Ethernet AND this SSH session does not use Wi-Fi
#   --no-start         install everything but do not (re)start the bridge
#   --skip-tests       do not run the bridge's unit tests on the Pi before installing the service
#   --dry-run          check the Pi and print every change it would make, change nothing
#
# Idempotent: run it again to update the code; the env file and the saved gimbal are kept unless --gimbal is given.
# Key-based SSH only (BatchMode): it never asks for or types a password. Every command run on the Pi is echoed
# with a "+ host:" prefix, so the output is the deploy log.
set -euo pipefail

HOST=""; PI_USER="pi"; MODE="auto"; GIMBAL=""; DIR=""; WIFI_OFF=0; NO_START=0; SKIP_TESTS=0; DRY=0
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --user) PI_USER="${2:?--user needs a name}"; shift 2 ;;
    --user-service) MODE="user"; shift ;;
    --system) MODE="system"; shift ;;
    --gimbal) GIMBAL="${2:?--gimbal needs an address}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --wifi-off) WIFI_OFF=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 2 ;;
    *) if [ -z "$HOST" ]; then HOST="$1"; shift; else echo "unexpected argument: $1" >&2; usage 2; fi ;;
  esac
done
[ -n "$HOST" ] || usage 2
if [ -n "$GIMBAL" ]; then
  GIMBAL="$(printf '%s' "$GIMBAL" | tr 'a-f' 'A-F')"
  printf '%s' "$GIMBAL" | grep -Eq '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$' || { echo "--gimbal must look like AA:BB:CC:DD:EE:FF" >&2; exit 2; }
fi
case "$PI_USER" in *[!A-Za-z0-9_.-]*|"") echo "bad --user" >&2; exit 2 ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/pi-bridge"
TARGET="$PI_USER@$HOST"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$TARGET")

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# Read-only probe on the Pi (runs in dry-run too).
probe() { printf '+ %s: %s\n' "$HOST" "$1" >&2; "${SSH[@]}" "$1"; }
# A change on the Pi (printed, not run, in dry-run).
change() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] would run on %s: %s\n' "$HOST" "$1"; return 0; fi
  printf '+ %s: %s\n' "$HOST" "$1"; "${SSH[@]}" "$1"
}
# Copy a local file to a path on the Pi (as the SSH user).
push() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] would copy %s to %s:%s\n' "$1" "$HOST" "$2"; return 0; fi
  printf '+ scp %s %s:%s\n' "$1" "$HOST" "$2"
  scp -q -o BatchMode=yes -o ConnectTimeout=10 "$1" "$TARGET:$2"
}

say "== DJI bridge install: $TARGET$( [ "$DRY" = 1 ] && echo ' (dry run: nothing is changed)')"

# ---------------------------------------------------------------- preflight (read-only)
"${SSH[@]}" true 2>/dev/null || die "key-based SSH to $TARGET failed. Set it up yourself first: ssh-copy-id $TARGET (you type the password)."
HOME_DIR="$(probe 'printf %s "$HOME"')"
[ -n "$DIR" ] || DIR="$HOME_DIR/dji-bridge"
case "$DIR" in /*) ;; *) die "--dir must be absolute" ;; esac
PY="$(probe 'python3 -c "import sys; print(\"%d.%d\" % sys.version_info[:2])" 2>/dev/null || echo none')"
MISSING=()
case "$PY" in none) MISSING+=("python3 (sudo apt install python3)") ;;
  *) [ "$(printf '%s\n3.10\n' "$PY" | sort -V | head -1)" = "3.10" ] || MISSING+=("Python >= 3.10 (found $PY; bleak>=3.0.2 needs it)") ;; esac
probe 'python3 -c "import venv, ensurepip" 2>/dev/null' >/dev/null || MISSING+=("python3-venv (sudo apt install python3-venv)")
probe 'command -v bluetoothctl >/dev/null' || MISSING+=("bluez / bluetoothctl (sudo apt install bluez)")
probe 'command -v rsync >/dev/null' || MISSING+=("rsync on the Pi (sudo apt install rsync)")
BT_ACTIVE="$(probe 'systemctl is-active bluetooth 2>/dev/null || true')"
[ "$BT_ACTIVE" = "active" ] || MISSING+=("the bluetooth service is '$BT_ACTIVE' (sudo systemctl enable --now bluetooth)")
PYPI="$(probe 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://pypi.org/simple/bleak/ 2>/dev/null || echo none')"
[ "$PYPI" = "200" ] || warn "the Pi cannot reach pypi.org (got $PYPI): pip install will fail unless the venv already has everything"
if [ "${#MISSING[@]}" -gt 0 ]; then printf 'Missing on %s:\n' "$HOST" >&2; printf '  - %s\n' "${MISSING[@]}" >&2; die "fix the above, then run this again"; fi

SUDO_OK=0; probe 'sudo -n true 2>/dev/null' && SUDO_OK=1
if [ "$MODE" = auto ]; then MODE=$([ "$SUDO_OK" = 1 ] && echo system || echo user); fi
if [ "$MODE" = system ] && [ "$SUDO_OK" = 0 ]; then
  die "--system needs passwordless sudo on $HOST. Rerun with --user-service (no sudo needed; recommended), or grant
  sudo yourself on the Pi (you type the password): see 'Passwordless sudo' in docs/pi-per-gimbal.md."
fi
LINGER="$(probe "loginctl show-user $PI_USER -p Linger --value 2>/dev/null || echo unknown")"
# Which interface this SSH session arrived on: the zone of a link-local address (fe80::..%eth0), else the
# interface holding the server-side address.
SSH_IFACE="$(probe 'set -- $SSH_CONNECTION; case "$3" in *%*) echo "${3#*%}" ;; *) ip -o addr | awk -v ip="$3" "index(\$4, ip\"/\")==1 {print \$2}" | head -1 ;; esac')"
ETH_UP="$(probe 'for i in /sys/class/net/e*; do [ -e "$i" ] || continue; n=${i##*/}; [ "$(cat $i/carrier 2>/dev/null)" = 1 ] && ip -4 -br addr show "$n" | grep -q "[0-9]\." && echo "$n"; done | head -1')"
WIFI_UP="$(probe 'ip -4 -br addr 2>/dev/null | awk "/^wl/ && \$2==\"UP\" {print \$1}" | head -1')"
JOURNAL_PERSISTENT="$(probe '[ -d /var/log/journal ] && echo yes || echo no')"
say "Pi: python $PY, bluetooth $BT_ACTIVE, pypi $PYPI, sudo $([ "$SUDO_OK" = 1 ] && echo passwordless || echo 'needs a password'), linger $LINGER"
say "    network: ssh via ${SSH_IFACE:-?}, ethernet ${ETH_UP:-none}, wifi ${WIFI_UP:-off}; persistent journal: $JOURNAL_PERSISTENT"
say "Install: mode $MODE, dir $DIR$( [ -n "$GIMBAL" ] && echo ", gimbal $GIMBAL")"

if [ "$MODE" = system ]; then STATE_DIR="/var/lib/dji-bridge"; else STATE_DIR="$HOME_DIR/.local/state/dji-bridge"; fi

# ---------------------------------------------------------------- code + venv
change "mkdir -p '$DIR'"
RSYNC=(rsync -az --delete --itemize-changes --exclude .venv --exclude __pycache__ --exclude '*.bak-*' --exclude '*.pyc'
       -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "$SRC/" "$TARGET:$DIR/")
if [ "$DRY" = 1 ]; then
  say "[dry-run] code that would change on $HOST:$DIR:"
  "${SSH[@]}" "[ -d '$DIR' ]" && "${RSYNC[@]}" --dry-run | sed 's/^/    /' || say "    (everything: $DIR does not exist yet)"
else
  printf '+ rsync pi-bridge/ -> %s:%s\n' "$HOST" "$DIR"; "${RSYNC[@]}" | sed 's/^/    /'
fi
change "[ -x '$DIR/.venv/bin/python3' ] || python3 -m venv '$DIR/.venv'"
change "'$DIR/.venv/bin/python3' -m pip install -q --disable-pip-version-check -r '$DIR/requirements.txt'"
change "'$DIR/.venv/bin/python3' -c 'import bleak, websockets; print(\"bleak\", bleak.__version__ if hasattr(bleak, \"__version__\") else \"?\", \"websockets\", websockets.__version__)' 2>/dev/null || '$DIR/.venv/bin/python3' -c 'import bleak, websockets; print(\"bleak + websockets import OK\")'"
if [ "$SKIP_TESTS" = 0 ]; then
  change "cd '$DIR' && out=\$('$DIR/.venv/bin/python3' -m unittest discover -s tests 2>&1); rc=\$?; printf '%s\n' \"\$out\" | tail -3; exit \$rc" \
    || die "the bridge's tests failed on the Pi; the service was not touched"
fi

# ---------------------------------------------------------------- the saved gimbal
if [ "$MODE" = system ]; then change "sudo -n install -d -o '$PI_USER' -g '$PI_USER' -m 755 '$STATE_DIR'"; else change "mkdir -p '$STATE_DIR'"; fi
if [ -n "$GIMBAL" ]; then
  change "DJI_BRIDGE_STATE_DIR='$STATE_DIR' '$DIR/.venv/bin/python3' '$DIR/dji_bridge.py' --select-gimbal '$GIMBAL'"
else
  probe "cat '$STATE_DIR/gimbal.json' 2>/dev/null || echo '(no gimbal saved: the bridge will use DJI_RS3_BLE_ADDRESS or pick the strongest DJI gimbal)'" | sed 's/^/    /'
fi

# ---------------------------------------------------------------- services
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ "$MODE" = system ]; then
  sed -e "s#^User=pi\$#User=$PI_USER#" -e "s#/home/pi/dji-bridge#$DIR#g" "$SRC/systemd/dji-bridge.service" > "$TMP/dji-bridge.service"
  push "$TMP/dji-bridge.service" "/tmp/dji-bridge.service.new"
  push "$SRC/system/pi-power-log" "/tmp/pi-power-log.new"
  push "$SRC/system/pi-power-log.service" "/tmp/pi-power-log.service.new"
  push "$SRC/system/10-persistent.conf" "/tmp/10-persistent.conf.new"
  push "$SRC/systemd/dji-bridge.env.example" "/tmp/dji-bridge.env.new"
  change "sudo -n install -m 644 /tmp/dji-bridge.service.new /etc/systemd/system/dji-bridge.service"
  change "[ -e /etc/default/dji-bridge ] || sudo -n install -m 644 /tmp/dji-bridge.env.new /etc/default/dji-bridge"
  change "sudo -n install -m 755 /tmp/pi-power-log.new /usr/local/bin/pi-power-log"
  change "sudo -n install -m 644 /tmp/pi-power-log.service.new /etc/systemd/system/pi-power-log.service"
  change "cmp -s /tmp/10-persistent.conf.new /etc/systemd/journald.conf.d/10-persistent.conf || { sudo -n install -D -m 644 /tmp/10-persistent.conf.new /etc/systemd/journald.conf.d/10-persistent.conf && sudo -n systemctl restart systemd-journald; }"
  change "rm -f /tmp/dji-bridge.service.new /tmp/pi-power-log.new /tmp/pi-power-log.service.new /tmp/10-persistent.conf.new /tmp/dji-bridge.env.new"
  change "sudo -n systemctl daemon-reload && sudo -n systemctl enable --now pi-power-log && sudo -n systemctl enable dji-bridge"
  [ "$NO_START" = 1 ] || change "sudo -n systemctl restart dji-bridge"
  STATUS_CMD="systemctl is-active dji-bridge"
else
  UENV='export XDG_RUNTIME_DIR=/run/user/$(id -u);'
  change "mkdir -p '$HOME_DIR/.config/systemd/user' '$HOME_DIR/.config/dji-bridge' '$HOME_DIR/.local/bin'"
  sed -e "s#%h/dji-bridge#$DIR#g" "$SRC/systemd/dji-bridge.user.service" > "$TMP/dji-bridge.service"
  push "$TMP/dji-bridge.service" "$HOME_DIR/.config/systemd/user/dji-bridge.service"
  push "$SRC/system/pi-power-log.user.service" "$HOME_DIR/.config/systemd/user/pi-power-log.service"
  push "$SRC/system/pi-power-log" "$HOME_DIR/.local/bin/pi-power-log"
  change "chmod 755 '$HOME_DIR/.local/bin/pi-power-log'"
  push "$SRC/systemd/dji-bridge.env.example" "/tmp/dji-bridge.env.new"
  change "[ -e '$HOME_DIR/.config/dji-bridge/env' ] || install -m 644 /tmp/dji-bridge.env.new '$HOME_DIR/.config/dji-bridge/env'; rm -f /tmp/dji-bridge.env.new"
  if [ "$LINGER" != yes ]; then
    change "loginctl enable-linger '$PI_USER'" || warn "could not enable lingering: the bridge will only run while $PI_USER is logged in. On the Pi run: sudo loginctl enable-linger $PI_USER"
  fi
  change "$UENV systemctl --user daemon-reload && systemctl --user enable --now pi-power-log && systemctl --user enable dji-bridge"
  [ "$NO_START" = 1 ] || change "$UENV systemctl --user restart dji-bridge"
  STATUS_CMD="$UENV systemctl --user is-active dji-bridge"
  [ "$JOURNAL_PERSISTENT" = yes ] || warn "the journal is not persistent on $HOST (no /var/log/journal); logs are lost at reboot. Fix needs sudo: sudo install -D -m 644 pi-bridge/system/10-persistent.conf /etc/systemd/journald.conf.d/ && sudo systemctl restart systemd-journald"
fi

# ---------------------------------------------------------------- Wi-Fi
if [ -n "$WIFI_UP" ]; then
  if [ "$WIFI_OFF" = 1 ]; then
    if [ -z "$ETH_UP" ]; then warn "not turning Wi-Fi off: no Ethernet link with an address on $HOST"
    elif [ "${SSH_IFACE#wl}" != "$SSH_IFACE" ] || [ -z "$SSH_IFACE" ]; then warn "not turning Wi-Fi off: this SSH session runs over ${SSH_IFACE:-an unknown interface}; reconnect over Ethernet first"
    elif [ "$MODE" = system ]; then change "sudo -n nmcli radio wifi off"
    else change "nmcli radio wifi off" || warn "nmcli refused without sudo; on the Pi run: sudo nmcli radio wifi off"
    fi
  else
    say "Note: $HOST has Wi-Fi up ($WIFI_UP) as well as Ethernet (${ETH_UP:-none}). A second radio next to the gimbal's Bluetooth can hurt the link; rerun with --wifi-off to turn it off (only done when SSH is on Ethernet)."
  fi
fi

# ---------------------------------------------------------------- verify
if [ "$DRY" = 1 ] || [ "$NO_START" = 1 ]; then say "== done$( [ "$DRY" = 1 ] && echo ' (dry run)')"; exit 0; fi
say "service: $(probe "$STATUS_CMD" || true)"
for _ in $(seq 1 20); do
  if INFO="$(curl -sS -m 3 "http://$HOST:7878/info" 2>/dev/null)" && [ -n "$INFO" ]; then say "GET http://$HOST:7878/info -> $INFO"; say "== done"; exit 0; fi
  sleep 1
done
die "the bridge did not answer GET http://$HOST:7878/info within 20 s; look at its log on the Pi ($( [ "$MODE" = system ] && echo 'journalctl -u dji-bridge -n 50' || echo 'journalctl --user -u dji-bridge -n 50'))"
