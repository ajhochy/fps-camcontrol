# DeckLink SDK 16 preservation — 2026-10-13

## Status, scope and provenance

Preservation only: READY_FOR_VERIFICATION of bytes/docs, **DRAFT BLOCKED / NOT READY
for build, capture, streaming or release**. Manager owns commits/push/PR and primary
checkout documentation; independent verifier/manager can repeat the read-only checks
below without write access. No feature, compatibility fix or script correction made.

Target: `/Users/ajhochhalter/Documents/fps-camcontrol-decklink-preservation`, branch
`preserve/decklink-sdk16-checkpoint`, unchanged base
`3f719b05f3dbc61ba4857347f05564c5f45bab45` (origin/integration/combine-open-prs, PR #60).
Source: primary `stash@{0}`, explicitly addressed by immutable object
`addc6d762547344c009bb425c132c7a57b3b19ac`, based on `84efc9a`.
Two parents only (no untracked third parent). The 53 scoped blobs are identical to
abandoned/reflog-only commit `50ffc5fd3bde287f4d6e6d4b56a99e6985038486`,
subject “program feed: vendored DeckLink SDK headers (Blackmagic's permissive header
licence) + scripts/setup-ffmpeg-decklink.sh”. This does not preserve unrelated history.

Authorized writes: the 53 source paths below and this receipt only. Excluded:
configurations, credentials, large media, binaries, app/runtime/features, primary
checkout edits, stash mutation, reset/clean, branch/worktree deletion, commits/push/PR.
Approval is unchanged; safety blockers are documented, not silently repaired.

## Phase 0 — acceptance contract

WAIVED: failing behavioral acceptance test for non-behavioral byte preservation.
Acceptance-contract then coding-agent skills loaded before implementation. Read
AGENTS.md and all six canonical docs/ai context files. Acceptance is all 53 paths,
no stale baseline overwritten, warning-only differences from stash and one truthful
receipt, no config/secrets/large media. Checks are byte equality (remove only the
two exact warning blocks), source/abandoned equality, baseline/stash-parent doc
comparison, complete inventory, text/license scan, bash syntax and git diff checks.
No system-under-test mock. Repository issue-level runtime checks are intentionally
not run under this static-only handoff; verifier owns primary/streaming testing.

## Phase 1 — consolidated review

Initial target worktree was clean and at the assigned branch/base. Entire 53-path
surface inspected via git tree/blob comparison. `git diff addc6d7^1 HEAD -- README.md
docs/program-feed.md scripts/setup-ffmpeg-decklink.sh third_party/decklink-sdk` was
empty: baseline docs equal the stash parent, and the other paths absent in both.
Thus explicit restore cannot discard newer baseline content; no contextual merge
needed. Stash-versus-abandoned scoped diff also empty (exit 0).

GitNexus lists only the primary fps-camcontrol index, at `a7eaa935`, stale 12 commits;
the target worktree has no separate index. Upstream impact for
`scripts/setup-ffmpeg-decklink.sh` returned Target not found / UNKNOWN, not proof of
zero risk. Literal `git grep` on target HEAD found no script/SDK references (exit 1).
The restored script is standalone, referenced only by preserved docs/NOTICE; no
shared application symbol or API handler edited. Static checks are proportionate.

Script blockers, inspected but deliberately left byte-identical:

- `curl -fL --retry 3` downloads and cached tarball reuse have no checksum/signature
  verification; archive content is extracted then configure/make executed.
- `--version` and `--prefix` consume `$2` without missing-value validation.
  VERSION is unchecked in URL, archive filename and `rm -rf "ffmpeg-$VERSION"`;
  traversal components can escape intended cleanup/extraction locations. Prefix
  can target unintended install destinations. Quoting does not validate paths.
- Fixed `${TMPDIR:-/tmp}/ffmpeg-decklink-build` is not a private unique scratch
  directory; cached archives, shim/logs and cleanup collide across runs and can
  be exposed to pre-existing directory/symlink manipulation. It removes the
  selected source directory and VERSION file, not the whole scratch directory.
- Flags contain unescaped include/scratch paths inside compiler flag strings;
  spaces/special characters are not robustly handled. `make install` is followed
  by real binary execution and DeckLink device enumeration. No authorization to
  execute this preserved script was used.

SDK version header says 16.0. Historical Studio driver 14.2 mismatch remains
unresolved (#63); no guess or observation of the current installed driver. Later
qualification needs an actual macOS Apple Silicon host, CLT (clang/make and other
build tools), and Desktop Video/framework compatible with the chosen SDK, then
separately authorized real capture. Major version alone is not qualification.
The script disables network, enables MJPEG/rawvideo encoders and only pipe/file
protocols; H.264 is a decoder, not an encoder, and AAC encoding is absent. This is
preview-only, unsuitable for the proposed streaming/recording runtime.

NOTICE and all 49 include-file license blocks are preserved verbatim. Headers
reference the Blackmagic EULA and third-party licensing conditions; NOTICE's
clause 0.1 exemption claim is preserved historical text, **not independent full
EULA qualification**. No EULA download/legal review performed. LGPL-only and
future bundling/source-offer claims are historical, not a validated built artifact
or redistribution authorization. No SDK binaries, samples or documentation added;
the include payload includes six .cpp dispatch source files, not just .h files.

## Phase 2 — commands and validation

Executed restore (exit 0):

```bash
git restore --source=addc6d762547344c009bb425c132c7a57b3b19ac --worktree -- README.md docs/program-feed.md scripts/setup-ffmpeg-decklink.sh third_party/decklink-sdk
```

Then inserted only prominent warning blocks in README and program-feed docs, and
added this receipt. No script/SDK code bytes corrected. Static commands:

```bash
bash -n scripts/setup-ffmpeg-decklink.sh
git diff --check
git diff --exit-code addc6d7 50ffc5fd3bde287f4d6e6d4b56a99e6985038486 -- README.md docs/program-feed.md scripts/setup-ffmpeg-decklink.sh third_party/decklink-sdk
```

Source inventory totals **397,872 bytes** across 53 blobs; largest is DeckLinkAPI.h
at 95,820 bytes. All are UTF-8 text, no NUL/binary payload or large media. Secret
review covers all candidate bytes and this receipt for private-key markers,
common token signatures and credential assignments; results recorded below.
No config/secrets paths included. This is bounded static review, not a guarantee
against every possible credential format. No network access, setup execution,
FFmpeg/app build, install, launch, capture/enumeration, PTZ, recording, drive,
SSH/deployment, runtime staging or hardware checks performed.

## Exact inventory and per-path inclusion reasons

Each path below is relative to the repository; each is retained from the assigned
stash rather than selectively pruning the original SDK include set.

| Path | Inclusion reason |
| --- | --- |
| README.md | Preserve optional program-feed entry and add blocked warning. |
| docs/program-feed.md | Preserve historical setup guidance and add blocked warning. |
| scripts/setup-ffmpeg-decklink.sh | Preserve original preview build recipe, not run or corrected. |
| third_party/decklink-sdk/NOTICE.md | Preserve upstream attribution and historical licensing statements. |
| third_party/decklink-sdk/include/DeckLinkAPI.h | Preserve main SDK interface definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration.h | Preserve current configuration interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v10_11.h | Preserve 10.11 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v10_2.h | Preserve 10.2 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v10_4.h | Preserve 10.4 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v10_5.h | Preserve 10.5 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v10_9.h | Preserve 10.9 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIConfiguration_v15_3_1.h | Preserve 15.3.1 configuration compatibility definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIDeckControl.h | Preserve deck-control interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIDiscovery.h | Preserve device-discovery interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch.cpp | Preserve current dynamic dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch_v10_11.cpp | Preserve 10.11 dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch_v10_8.cpp | Preserve 10.8 dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch_v14_2_1.cpp | Preserve 14.2.1 dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch_v15_2.cpp | Preserve 15.2 dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIDispatch_v15_3_1.cpp | Preserve 15.3.1 dispatch source. |
| third_party/decklink-sdk/include/DeckLinkAPIGLScreenPreview_v14_2_1.h | Preserve legacy GL preview interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIMemoryAllocator_v14_2_1.h | Preserve legacy memory allocator interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIMetalScreenPreview_v14_2_1.h | Preserve legacy Metal preview interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIModes.h | Preserve video mode definitions. |
| third_party/decklink-sdk/include/DeckLinkAPIScreenPreviewCallback_v14_2_1.h | Preserve legacy preview callback interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIStreaming.h | Preserve SDK streaming interfaces, not implemented app streaming. |
| third_party/decklink-sdk/include/DeckLinkAPIStreaming_v10_11.h | Preserve legacy SDK streaming interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPITypes.h | Preserve shared SDK types. |
| third_party/decklink-sdk/include/DeckLinkAPIVersion.h | Preserve exact SDK 16.0 version identity. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoConversion_v14_2_1.h | Preserve legacy video conversion interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoEncoderInput_v10_11.h | Preserve legacy encoder input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoFrame3DExtensions_v14_2_1.h | Preserve legacy 3D frame extensions. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoFrame_v14_2_1.h | Preserve legacy frame interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoInput_v10_11.h | Preserve 10.11 input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoInput_v11_4.h | Preserve 11.4 input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoInput_v11_5_1.h | Preserve 11.5.1 input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoInput_v14_2_1.h | Preserve 14.2.1 input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoInput_v15_3_1.h | Preserve 15.3.1 input interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoOutput_v10_11.h | Preserve 10.11 output interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoOutput_v11_4.h | Preserve 11.4 output interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoOutput_v14_2_1.h | Preserve 14.2.1 output interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPIVideoOutput_v15_3_1.h | Preserve 15.3.1 output interfaces. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_11.h | Preserve 10.11 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_2.h | Preserve 10.2 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_4.h | Preserve 10.4 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_5.h | Preserve 10.5 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_6.h | Preserve 10.6 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v10_9.h | Preserve 10.9 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v11_5.h | Preserve 11.5 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v11_5_1.h | Preserve 11.5.1 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v14_2_1.h | Preserve 14.2.1 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v15_2.h | Preserve 15.2 compatibility entrypoints. |
| third_party/decklink-sdk/include/DeckLinkAPI_v15_3_1.h | Preserve 15.3.1 compatibility entrypoints. |

Additional path: `docs/ai/runs/2026-10-13-decklink-preservation.md` — this truthful
receipt, scope/commands/blockers, exact inventory and independent handoff.

## Observed results and historical pre-staging check

First validation attempt passed; no repair loop needed. `bash -n` exit 0,
`git diff --check` exit 0, Python static acceptance exit 0. All 53 blobs match
stash after removal of exactly one added warning block in each of the two docs;
51 other paths byte-identical. Exactly 54 worktree changed/untracked paths,
index unchanged, script executable mode retained. All 49 license blocks intact.
Source total 397,872 bytes; current 53-path total **399,286 bytes** (1,414 bytes
of warnings only). Receipt is additional to that candidate total.
Bounded secret review of the 54 files found zero private-key markers, GitHub
token signatures, AWS access-key IDs, Slack tokens or quoted credential
assignments. No binary/config/secrets/media path introduced. This is not full
entropy-based scanning or independent legal/security qualification.

The following snippet records the **historical pre-staging** check only. It
requires an empty index and an unstaged/untracked 54-path payload, so it is
**not valid after staging or commit** and must not be repeated as the final gate.
Final staged verification uses `git diff --cached --name-status`, reads bytes
with `git show :<path>`, hashes those index blobs, compares the 53 bodies against
the immutable stash (removing only the two warning blocks), checks index Markdown
links/secrets/license blocks, and verifies `git diff --exit-code` for no unstaged
drift. The independent final verifier executed those index-based checks.

Historical command (read-only, no network/runtime):

```bash
bash -n scripts/setup-ffmpeg-decklink.sh && git diff --check && python3 - <<'PY'
from pathlib import Path
import subprocess, re, os
def git(*args): return subprocess.check_output(['git', *args])
s = 'addc6d762547344c009bb425c132c7a57b3b19ac'
r = 'docs/ai/runs/2026-10-13-decklink-preservation.md'
paths = git('diff', '--name-only', s+'^1', s).decode().splitlines()
assert len(paths) == 53
for p in paths:
    b = Path(p).read_bytes()
    if p in ('README.md', 'docs/program-feed.md'):
        b, n = re.subn(rb'^> \*\*.*?(?:\n>[^\n]*)*\n\n', b'', b, flags=re.M)
        assert n == 1
    assert b == git('show', s+':'+p), p
    assert b'\0' not in b
    b.decode('utf-8')
    if '/include/' in p:
        assert b'-LICENSE-START-' in b and b'-LICENSE-END-' in b
    assert '| '+p+' |' in Path(r).read_text()
changed = git('diff', '--name-only').decode().splitlines()
changed += git('ls-files', '--others', '--exclude-standard').decode().splitlines()
assert set(changed) == set(paths+[r])
assert git('diff', '--cached') == b''
assert git('diff', s+'^1', 'HEAD', '--', *paths) == b''
assert git('diff', s, '50ffc5fd3bde287f4d6e6d4b56a99e6985038486', '--', *paths) == b''
assert os.access('scripts/setup-ffmpeg-decklink.sh', os.X_OK)
assert sum(Path(p).stat().st_size for p in paths) == 399286
patterns = [rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            rb'gh[pousr]_[A-Za-z0-9]{20,}', rb'github_pat_[A-Za-z0-9_]{20,}',
            rb'AKIA[0-9A-Z]{16}', rb'xox[baprs]-[A-Za-z0-9-]{10,}',
            rb'(?i)(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*[\x22\x27][^\x22\x27\n]{8,}[\x22\x27]']
assert not [(p, i) for p in paths+[r] for i, pat in enumerate(patterns)
            if re.search(pat, Path(p).read_bytes())]
print('PASS: preservation, scope, licenses, warning-only diff and bounded secrets')
PY
```

Handoff: manager/verifier uses the index-based final checks above before Git
publication, not the historical empty-index snippet. Build/driver/script remediation requires separate scoped work;
preservation acceptance does not close #63 or qualify streaming. Do not execute
the script or revive historical hardware instructions from these preserved docs.

## Manager staged-payload check

After explicit staging of the 54 authorized paths, `git diff --cached --check`
exited **2**, reporting **982 whitespace findings** in preserved upstream SDK
include files (including their license text). The earlier unstaged diff check
did not inspect untracked headers and is not an all-payload green result.
SDK bytes remain exact copies: no whitespace normalization of upstream notices
or source was performed. This is disclosed draft preservation, not a waived
clean-whitespace/build gate. Script `bash -n` still exits 0; no script execution.
