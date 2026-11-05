# Third-party notices: bundled FFmpeg runtime

FPS CamControl ships `ffmpeg` and `ffprobe` as separate executables in `Resources/ffmpeg-runtime/`. The app starts them
as child processes and does not link them into itself. You may replace them with your own build of the same version.

## FFmpeg 8.1.3

- License: GNU Lesser General Public License, version 3 or later (LGPL-3.0-or-later). The full text is in
  `COPYING.LGPLv3`, and FFmpeg's own license summary is in `LICENSE.md` (both copied unchanged from the source tarball).
- Corresponding source: `https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz`, SHA-256
  `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3` (PGP-verified with the FFmpeg release key
  FCF986EA15E6E293A5644F10B4322F04D67658D8).
- Build: `scripts/build-ffmpeg-runtime.sh` in the FPS CamControl repository (https://github.com/ajhochy/fps-camcontrol),
  with the configure line in `scripts/ffmpeg-runtime-manifest.json`: no `--enable-gpl`, no `--enable-nonfree`,
  `--enable-version3`, H.264 through Apple VideoToolbox, FFmpeg's native AAC encoder.

## OpenSSL 3.5.9 (statically linked into ffmpeg and ffprobe)

- License: Apache License 2.0. The full text is in `OPENSSL-LICENSE.txt` (copied unchanged from the source tarball).
- Source: `https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz`, SHA-256
  `603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a`.

## Not included

No Blackmagic DeckLink code is part of these binaries. Program capture uses the separate `camcontrol-capture` helper.
