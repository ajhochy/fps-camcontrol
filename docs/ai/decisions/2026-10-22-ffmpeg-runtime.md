---
date: 2026-10-22
repo: fps-camcontrol
tags: [decision, fps-camcontrol, streaming, licensing]
index: "[[fps-camcontrol]]"
---

# Streaming FFmpeg runtime: pinned LGPL build from source (recommended), delivery contract and capability gate

Issue #65 (S02). **Status: PROPOSED, awaiting AJ's approval of the downloads in "Download list".** Nothing was downloaded or built; the only binary exercised is the Homebrew developer FFmpeg 8.1.2 (a GPL, `--enable-shared` build that is **not** redistributable and must never ship). Scaffold: [capability contract](../../../scripts/ffmpeg-runtime-capabilities.json), [delivery manifest](../../../scripts/ffmpeg-runtime-manifest.json) (status `SCAFFOLD-UNPINNED`), [probe + manifest verifier](../../../scripts/probe-ffmpeg-runtime.cjs), [build script](../../../scripts/build-ffmpeg-runtime.sh) (refuses to run until the manifest is pinned; never downloads). Evidence: [S04/S05 run notes](../runs/2026-10-22-streaming-s04-mp4-recovery.md), [probe report](../runs/2026-10-22-ffmpeg-runtime-probe-homebrew.json).

## Decision

1. **Bundle our own FFmpeg + ffprobe, built from the pinned official source tarball, as LGPL v3-or-later**, arm64 only (D4), no `--enable-gpl`, no `--enable-nonfree`, no DeckLink. H.264 comes from VideoToolbox (`h264_videotoolbox`), AAC from FFmpeg's native encoder, TLS from a statically linked OpenSSL 3.5 LTS (Apache-2.0, hence `--enable-version3`, hence LGPL **v3**). No x264/x265, so there is no GPL obligation and no patent-encumbered software encoder in the binary.
2. **DeckLink stays out of FFmpeg.** Capture is the separate `native/decklink-capture` helper (ADR 2026-10-13); the FFmpeg input is `-f matroska -i pipe:0` carrying raw UYVY + PCM. This keeps the shipped FFmpeg free of nonfree DeckLink code and makes the delivery path "bundled redistributable binary" for FFmpeg, "operator-installed Desktop Video + our compiled helper" for capture (SDK 14.2 EULA notes in the helper run note).
3. **Installed use never consults PATH/Homebrew.** The app resolves `Resources/ffmpeg-runtime/ffmpeg` by absolute path; before the first session it runs the capability probe against that exact file and verifies the staged directory against the manifest (`verify-manifest --require-pinned`). Developer builds may override with `BROADCAST_FFMPEG`; installed builds may not.
4. **Version: FFmpeg 8.1.3** (same 8.1 branch all #66/#67/#68 evidence was gathered on, 8.1.2; patch release 2026-09-21). 9.0.2 (2026-09-18) is the newer stable; it is not chosen because every timing/recovery result here is on 8.1.x and a major branch change would invalidate them. Re-run the S04/S05 harnesses against whichever binary is pinned (they take `BROADCAST_FFMPEG`).
5. **GPL is allowed only as a recorded exception**, never silently: the probe fails a GPL binary unless `--allow-gpl` is passed. A prebuilt static GPL binary (below) is acceptable only for developer use or as a stop-gap if AJ explicitly accepts the GPL bundling obligations (full corresponding source offer for FFmpeg and every GPL library; the app itself is open source so this is feasible but heavier).

## Options compared

| Option | Version / date (as reported 2026-10-22) | arm64 | License of binary | VideoToolbox / TLS | Integrity | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Build from `ffmpeg.org` tarball with our configure line** | 8.1.3 (2026-09-21), tarball 11,732,036 B | yes (we build) | **LGPL v3+** (our flags) | VideoToolbox yes (system framework); OpenSSL 3.5.9 LTS static | PGP `.asc` by FFmpeg release key, SHA-256 computed and pinned by us; OpenSSL publishes `.sha256` + PGP | **Chosen.** Costs a one-time scripted build on AJ's Mac (Xcode CLT, ~10-15 min) |
| martin-riedl.de static build ([builds](https://ffmpeg.martin-riedl.de/)) | release 9.0.2 (2026-09-20), `ffmpeg.zip` 28,395,699 B, `ffprobe.zip` 28,317,701 B | yes | **GPL** (x264/x265 listed; page does not state it) | page does not list VideoToolbox; OpenSSL listed | `.sha256` per zip, binaries signed (not stated notarized for zips); build script open ([git.martin-riedl.de/ffmpeg/build-script](https://git.martin-riedl.de/ffmpeg/build-script)) | **Best prebuilt fallback**, developer or GPL-exception only; probe must confirm VideoToolbox + `tee`/`fifo` before any use |
| osxexperts.net `ffmpeg9arm.zip` | labelled 9.0, "compiled from release/6.1 branch" (inconsistent), 22,608,364 B | yes | **GPL**, "for educational purposes only" | VideoToolbox not in the listed libs | SHA-256 on the page, no signature | **Rejected**: provenance/version contradiction, no redistribution grant |
| evermeet.cx | 9.0.2 / snapshot 127892 | **x86_64 only** ("no native Apple Silicon") | GPL v3 (`--enable-gpl --enable-version3`) | n/a | GPG signature, no SHA-256 | **Rejected** (wrong architecture) |
| Homebrew `ffmpeg` (current developer binary) | 8.1.2 | yes | GPL v3+, `--enable-shared` (needs Homebrew dylibs) | VideoToolbox + OpenSSL | brew bottle | **Developer only; never bundled** (fails the PATH/Homebrew rule and is not self-contained) |

SecureTransport: FFmpeg's TLS layer can use Apple's SecureTransport (system framework, no extra library to ship). No source found that it is removed, but it is a legacy API; OpenSSL was chosen because the proven developer binary uses it (RTMPS handshake verified here), it is portable, and its Apache-2.0 license is compatible with LGPLv3. If AJ prefers zero bundled crypto, rebuild with `--disable-openssl --enable-securetransport` (drop `--enable-version3`: that variant would be LGPL v2.1+) and rerun the TLS probe; the manifest and probe are agnostic.

## License / notices inventory (not legal advice)

- FFmpeg configured `--disable-gpl --disable-nonfree --enable-version3`: **LGPL v3 or later**. Obligations: ship the LGPLv3 text and FFmpeg's license notice, state that FFmpeg is used, provide the corresponding source (we link the exact tarball URL + checksum) and the configure line and build script (this repo), do not prohibit relinking/replacement: ship `ffmpeg`/`ffprobe` as separate executables the user can replace (they are, and the app launches them as child processes, not linked into the app).
- OpenSSL 3.5.x: Apache-2.0 (notice + license text; no source-offer duty).
- Apple frameworks (VideoToolbox, AudioToolbox, CoreFoundation, Security, ...): system, not redistributed.
- Patents: H.264/AAC encoders are the platform's (VideoToolbox) and FFmpeg's native AAC; patent licensing of H.264/AAC distribution is the shipper's question regardless of build, flagged for AJ.
- Marks: "DeckLink" only in the permitted phrasing (helper run note). No Blackmagic binary is bundled.
- `THIRD_PARTY_NOTICES.md` generation (#52) must add FFmpeg + OpenSSL entries from the manifest; packaging/signing/notarization of the nested binaries is #86.

## Capability evidence (developer binary, proves the probe works)

`node scripts/probe-ffmpeg-runtime.cjs probe /opt/homebrew/bin/ffmpeg --allow-gpl` passes: version 8.1.2, every required encoder/decoder/muxer/demuxer/protocol/filter/pixel format present, `h264_videotoolbox` + native `aac`, `tee`, `fifo`, `flv`, `mp4`, `matroska` demux, `rtmp`/`rtmps`/`tls`/`subfile`, OpenSSL; functional checks pass: synthetic VideoToolbox H.264 + AAC through the production tee/fifo shape into hybrid-fragmented MP4 + FLV (both decode clean, codecs `aac,h264`), the capture-helper stdin shape (Matroska UYVY + PCM s32le -> MP4), and a loopback TLS 1.3 handshake. Without `--allow-gpl` the same binary is rejected (`gpl-3.0-or-later`), proving the license gate. DeckLink/nonfree flags are rejected by the contract. Not exercised (no pinned binary exists): the pinned-binary probe, `otool -L` self-containment, the manifest's pinned hashes.

## Download list (awaiting AJ's approval; nothing fetched)

| # | URL | File | Size | Integrity source |
| --- | --- | --- | --- | --- |
| 1 | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz | ffmpeg-8.1.3.tar.xz | 11,732,036 B | detached PGP signature below + the FFmpeg release key; we then pin the computed SHA-256 in the manifest (ffmpeg.org publishes no checksum file) |
| 2 | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz.asc | signature | small | verify against key 3 |
| 3 | https://ffmpeg.org/ffmpeg-devel.asc | FFmpeg release signing key | 1,709 B | compare the fingerprint with ffmpeg.org/download.html out of band |
| 4 | https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz | openssl-3.5.9.tar.gz | about 50.8 MiB | `.sha256` and `.asc` in the same release directory; signing key fingerprint B146 647E 45A7 B339 47AB 226B 2A2C 87D1 6169 2D40 (re-verify at openssl-library.org/source) |
| 5 | the `.sha256` and `.asc` next to #4 | checksum + signature | small | as above |

Fallback only if building is rejected (developer/GPL-exception use): https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip (28,395,699 B), `.../ffprobe.zip` (28,317,701 B) and each `.sha256` beside them. Build prerequisites on the build Mac: Xcode command line tools, `pkg-config`, `nasm` not required for arm64.

## Open / blockers

- AJ approval for the downloads (and for a GPL exception if the build route is refused).
- Pinned binary does not exist yet: pinned SHA-256s, `otool -L` self-containment, probe report of the shipped pair, re-run of the S03/S04/S05 harnesses against it, and notices text are open. Capture of DeckLink content is unchanged (helper).
- Whether the narrowed `--enable-protocol` list configures cleanly is unverified until the first build; the probe, not the flag list, is the gate.
- Patent/licensing counsel question for distributing H.264/AAC encoders, and Blackmagic confirmation for the compiled helper, remain with AJ (#86).
