#!/usr/bin/env bash
# Build a local CameraWebApp from a separately downloaded Sony SDK ZIP.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-sony-sidecar.sh --checkout /path/to/alpha-sdk-api --zip /path/to/sony-sdk.zip [--accept-sony-license]

Both paths must already exist locally. This helper never downloads, clones, or redistributes Sony assets. It applies scripts/sony-sidecar-status-fix.patch to the checkout before building.
Set SONY_LICENSE_ACCEPTED=1 or pass --accept-sony-license only after you have accepted Sony's SDK license.
EOF
}

checkout=""
sdk_zip=""
license_accepted="${SONY_LICENSE_ACCEPTED:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --checkout)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      checkout="$2"
      shift 2
      ;;
    --zip)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      sdk_zip="$2"
      shift 2
      ;;
    --accept-sony-license)
      license_accepted="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$checkout" ] && [ -n "$sdk_zip" ] || { usage >&2; exit 2; }
[ -d "$checkout" ] || { printf 'Checkout directory does not exist: %s\n' "$checkout" >&2; exit 2; }
[ -f "$checkout/crsdk" ] && [ -x "$checkout/crsdk" ] || { printf 'Expected executable ./crsdk in checkout: %s\n' "$checkout" >&2; exit 2; }
[ -f "$sdk_zip" ] || { printf 'Sony SDK ZIP does not exist: %s\n' "$sdk_zip" >&2; exit 2; }

if [ "$license_accepted" != "1" ]; then
  printf 'Sony Camera Remote SDK files are subject to Sony terms and are not redistributed by this project.\n'
  printf 'Have you already accepted Sony\047s SDK license for this ZIP? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) printf 'Sony license acceptance is required; no changes were made.\n' >&2; exit 1 ;;
  esac
fi

# Sidecar fix: make /api/server/status answer from the last scan instead of running
# discovery (which blocks behind Sony's SDK and races with connect). Idempotent.
# Every scripts/sony-sidecar-*.patch is applied in name order (status fix, live-view rate, ...).
script_dir="$(cd "$(dirname "$0")" && pwd)"
set -- "$script_dir"/sony-sidecar-*.patch
[ -f "$1" ] || { printf 'Missing patch files: %s/sony-sidecar-*.patch\n' "$script_dir" >&2; exit 1; }
for patch_file in "$@"; do
  name="$(basename "$patch_file")"
  if git -C "$checkout" apply --check --reverse "$patch_file" >/dev/null 2>&1; then
    printf 'Sidecar patch already applied: %s\n' "$name"
  elif git -C "$checkout" apply --check "$patch_file" >/dev/null 2>&1; then
    git -C "$checkout" apply "$patch_file"
    printf 'Applied sidecar patch: %s\n' "$name"
  else
    printf 'The patch %s does not apply to this checkout (upstream changed?): %s\n' "$name" "$checkout" >&2
    printf 'Check out the tested revision or refresh scripts/%s; no build was run.\n' "$name" >&2
    exit 1
  fi
done

(
  cd "$checkout"
  ./crsdk install --zip "$sdk_zip"
  ./crsdk build
)

case "$(uname -s)" in
  Darwin|Linux) executable="$checkout/api/server/build/CameraWebApp" ;;
  MINGW*|MSYS*|CYGWIN*) executable="$checkout/api/server/build/Release/CameraWebApp.exe" ;;
  *) printf 'Unsupported platform; locate CameraWebApp under: %s\n' "$checkout/build" >&2; exit 1 ;;
esac

[ -f "$executable" ] && [ -x "$executable" ] || { printf 'CameraWebApp was not built as an executable: %s\n' "$executable" >&2; exit 1; }

printf '\nCameraWebApp executable: %s\n' "$executable"
printf 'FPS runtime example (runtime launch is separate):\n'
printf '  SONY_SERVER_EXECUTABLE=%q SONY_API_URL=http://127.0.0.1:8181 pnpm start\n' "$executable"
printf 'Direct temporary launch: %q --port 8181\n' "$executable"
printf 'Check health: curl --fail http://127.0.0.1:8181/api/server/status\n'
