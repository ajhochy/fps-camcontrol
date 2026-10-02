---
date: 2026-10-01
repo: fps-camcontrol
tags: [decision, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Dual-variant testing releases modeled on Rhythm

## Context

The user authorized a testing release of the two unmerged Electron PRs and asked
to mirror Rhythm's release workflow. FPS has locally signed/notarized installers,
but no repository Apple signing secrets. Copying credentials requires a separate
answer; exporting a private key or merging either PR is not authorized.

## Decision

Keep the workflow on PR58, with independent full-SHA source pins for manual and
tracking builds. Mirror Rhythm's dispatch, temporary hosted keychain, Apple
notarization, signed-app verification and artifact publication pattern. Adapt it
to a native ARM64 matrix, explicit qualification-only mode, credential-free PR
validation and a single publisher that verifies both downloaded installers
before publishing an immutable prerelease. Testing tags can bootstrap the
unmerged workflow. The release label is separate from the embedded app version.

Publish the existing qualified local installer bytes for the initial release,
with an explicit local-build manifest, original source commits and checksum
readback. Use an `electron-local-testing-*` tag outside the hosted build trigger.
Do not claim successful hosted signing, clean-OS acceptance or physical tracking.

## Alternatives considered

- Wait for GitHub credentials before providing any download: unnecessary when
  the exact notarized local bytes can already be independently verified.
- Merge first or change the app version just to publish: expands authorization
  and invalidates the already-qualified binary provenance.
- Let each matrix job publish independently: risks a partial two-variant release.

## Consequences

The initial downloads are locally built, not a hosted-build qualification. A
future hosted qualification run still requires authorized secret setup and must
pass both macOS jobs before publication. Real-person/physical-rig and clean-Mac
testing remain separate gates, and neither source PR is merged by publication.
