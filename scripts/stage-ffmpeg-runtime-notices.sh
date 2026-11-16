#!/bin/sh
# Add the license files and notices that ship next to the bundled ffmpeg/ffprobe (issue #65). The license texts are copied
# byte-for-byte from the pinned, checksum-verified source tarballs, never retyped.
#   scripts/stage-ffmpeg-runtime-notices.sh <dir containing the verified tarballs> <runtime output dir>
set -eu
SRC=${1:?directory with the pinned tarballs}; OUT=${2:?runtime output directory}
HERE=$(cd "$(dirname "$0")" && pwd); MANIFEST="$HERE/ffmpeg-runtime-manifest.json"
val() { node -e "const m=require('$MANIFEST');console.log(process.argv[1].split('.').reduce((o,k)=>o[k],m))" "$1"; }
FF_TAR="$SRC/$(val source.0.filename)"; SSL_TAR="$SRC/$(val source.1.filename)"
for pair in "$FF_TAR:source.0.sha256" "$SSL_TAR:source.1.sha256"; do
  f=${pair%%:*}; want=$(val "${pair#*:}"); got=$(shasum -a 256 "$f" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "checksum mismatch for $f" >&2; exit 4; }
done
FF_DIR=$(basename "$FF_TAR" .tar.xz); SSL_DIR=$(basename "$SSL_TAR" .tar.gz)
tar -xJOf "$FF_TAR" "$FF_DIR/LICENSE.md" > "$OUT/LICENSE.md"
tar -xJOf "$FF_TAR" "$FF_DIR/COPYING.LGPLv3" > "$OUT/COPYING.LGPLv3"
tar -xzOf "$SSL_TAR" "$SSL_DIR/LICENSE.txt" > "$OUT/OPENSSL-LICENSE.txt"
cp "$HERE/ffmpeg-runtime/THIRD_PARTY_FFMPEG.md" "$OUT/THIRD_PARTY_FFMPEG.md"
echo "notices staged: $OUT"
