#!/bin/sh
# Reproducible LGPL FFmpeg + OpenSSL build for the streaming runtime (issue #65). NOT RUN BY THE REPO: it needs the pinned source tarballs, which
# are downloaded only after explicit approval (see docs/ai/decisions/2026-10-22-ffmpeg-runtime.md). This script never downloads anything itself.
#   scripts/build-ffmpeg-runtime.sh <dir containing the verified tarballs> <output dir>
# Steps: verify tarball SHA-256 against scripts/ffmpeg-runtime-manifest.json (refuses unpinned), build static OpenSSL into a private prefix,
# configure FFmpeg with the manifest flags, install ffmpeg/ffprobe, strip, then run the capability probe WITHOUT --allow-gpl.
set -eu
SRC=${1:?directory with ffmpeg-<v>.tar.xz and openssl-<v>.tar.gz}; OUT=${2:?output directory (must not exist)}
HERE=$(cd "$(dirname "$0")" && pwd); MANIFEST="$HERE/ffmpeg-runtime-manifest.json"
[ ! -e "$OUT" ] || { echo "refusing to reuse $OUT" >&2; exit 2; }
val() { node -e "const m=require('$MANIFEST');const f=process.argv[1].split('.').reduce((o,k)=>o[k],m);console.log(Array.isArray(f)?f.join(' '):f)" "$1"; }
FF_TAR="$SRC/$(val source.0.filename)"; SSL_TAR="$SRC/$(val source.1.filename)"
for pair in "$FF_TAR:source.0.sha256" "$SSL_TAR:source.1.sha256"; do
  f=${pair%%:*}; key=${pair#*:}; want=$(val "$key")
  [ "$want" != "null" ] || { echo "manifest $key is not pinned: verify the PGP signature, pin the SHA-256, then re-run" >&2; exit 3; }
  got=$(shasum -a 256 "$f" | cut -d' ' -f1); [ "$got" = "$want" ] || { echo "checksum mismatch for $f" >&2; exit 4; }
done
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ffrt-build.XXXXXX"); trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"; mkdir -p "$PREFIX" "$OUT"
export MACOSX_DEPLOYMENT_TARGET=$(val minimumMacOS)
( cd "$WORK" && tar xf "$SSL_TAR" && cd openssl-* && ./Configure darwin64-arm64-cc no-shared no-tests --prefix="$PREFIX" --libdir=lib && make -j"$(sysctl -n hw.ncpu)" && make install_sw )
( cd "$WORK" && tar xf "$FF_TAR" && cd ffmpeg-* && PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$WORK/ffinstall" $(val configure) --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" && make -j"$(sysctl -n hw.ncpu)" && make install )
cp "$WORK/ffinstall/bin/ffmpeg" "$WORK/ffinstall/bin/ffprobe" "$OUT/"; strip -x "$OUT/ffmpeg" "$OUT/ffprobe"
otool -L "$OUT/ffmpeg" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/)' && { echo "ffmpeg links a non-system library" >&2; exit 5; } || true
node "$HERE/probe-ffmpeg-runtime.cjs" probe "$OUT/ffmpeg" --json "$OUT/probe-report.json" >/dev/null
echo "built and probed (LGPL, no --allow-gpl): $OUT"
