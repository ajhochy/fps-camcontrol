#!/usr/bin/env bash
# Build a small LGPL ffmpeg with the DeckLink (Blackmagic) and AVFoundation inputs and the MJPEG
# encoder, for CamControl's live program feed (docs/program-feed.md). Nothing GPL, nothing from
# Homebrew is changed: the result lives in its own prefix (default ~/Developer/ffmpeg-decklink).
#
#   scripts/setup-ffmpeg-decklink.sh [--prefix DIR] [--version 8.1.3]
#
# Needs: macOS with Xcode Command Line Tools (clang, make), Blackmagic Desktop Video installed
# (/Library/Frameworks/DeckLinkAPI.framework) for the binary to run, ~400 MB of scratch space.
# Downloads the ffmpeg source tarball from ffmpeg.org (about 12 MB). Idempotent: re-run to rebuild.
set -euo pipefail
PREFIX="$HOME/Developer/ffmpeg-decklink"
VERSION="8.1.3"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SDK_INCLUDE="$REPO/third_party/decklink-sdk/include"
[ -f "$SDK_INCLUDE/DeckLinkAPI.h" ] || { echo "missing $SDK_INCLUDE/DeckLinkAPI.h" >&2; exit 1; }
command -v clang >/dev/null || { echo "clang not found: xcode-select --install" >&2; exit 1; }
WORK="${TMPDIR:-/tmp}/ffmpeg-decklink-build"
mkdir -p "$WORK" "$PREFIX"
cd "$WORK"
TARBALL="ffmpeg-$VERSION.tar.xz"
if [ ! -f "$TARBALL" ]; then
  echo "Downloading https://ffmpeg.org/releases/$TARBALL"
  curl -fL --retry 3 -o "$TARBALL.part" "https://ffmpeg.org/releases/$TARBALL" && mv "$TARBALL.part" "$TARBALL"
fi
rm -rf "ffmpeg-$VERSION"
tar xf "$TARBALL"
cd "ffmpeg-$VERSION"
# macOS filesystems are case-insensitive: libc++'s `#include <version>` would pick up ffmpeg's top-level VERSION
# file and the C++ DeckLink unit fails with "expected unqualified-id". The file only feeds the version string.
rm -f VERSION
# DeckLink SDK 16 dropped the Mac `IID_IUnknown` convenience define that ffmpeg's decklink_dec.cpp uses; CoreFoundation's
# IUnknownUUID is the same UUID, so a one-line shim header supplies it (pulled in with -include; a -D with
# parentheses would break make's shell line).
cat > "$WORK/decklink_shim.h" <<'SHIM'
#include <CoreFoundation/CFPlugInCOM.h>
#ifndef IID_IUnknown
#define IID_IUnknown CFUUIDGetUUIDBytes(IUnknownUUID)
#endif
SHIM
# LGPL only: no --enable-gpl, no --enable-nonfree. Just what the program feed needs.
./configure --prefix="$PREFIX" \
  --disable-everything --disable-doc --disable-ffplay --disable-ffprobe --disable-network \
  --disable-autodetect --disable-debug --extra-version="camcontrol-decklink" \
  --enable-avdevice --enable-avfilter --enable-swscale \
  --enable-indev=decklink,avfoundation --enable-decklink \
  --enable-decoder=rawvideo,mjpeg,h264 --enable-demuxer=rawvideo,mjpeg,image2 \
  --enable-encoder=mjpeg,rawvideo --enable-muxer=mjpeg,image2,rawvideo \
  --enable-protocol=pipe,file \
  --enable-filter=scale,fps,format,null \
  --extra-cflags="-I$SDK_INCLUDE" \
  --extra-cxxflags="-I$SDK_INCLUDE -include $WORK/decklink_shim.h" \
  --extra-ldflags="-framework CoreFoundation -framework CoreMedia -framework CoreVideo -framework AVFoundation -framework Foundation" \
  >"$WORK/configure.log" 2>&1 || { tail -30 "$WORK/configure.log"; echo "configure failed; see $WORK/configure.log and ffbuild/config.log" >&2; exit 1; }
make -j"$(sysctl -n hw.ncpu)" >"$WORK/make.log" 2>&1 || { tail -30 "$WORK/make.log"; echo "make failed; see $WORK/make.log" >&2; exit 1; }
make install >/dev/null
echo
echo "ffmpeg installed: $PREFIX/bin/ffmpeg"
"$PREFIX/bin/ffmpeg" -hide_banner -version | head -1
printf 'decklink input: '; "$PREFIX/bin/ffmpeg" -hide_banner -devices 2>/dev/null | grep -q decklink && echo yes || echo NO
echo "DeckLink devices seen (needs Desktop Video + a connected device):"
"$PREFIX/bin/ffmpeg" -hide_banner -sources decklink 2>&1 | sed -n '1,8p'
echo
echo "Point CamControl at it: program.ffmpegPath: $PREFIX/bin/ffmpeg (devices.yaml, or PUT /api/program)."
