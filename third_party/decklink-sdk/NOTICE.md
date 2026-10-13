# Blackmagic DeckLink SDK headers

`include/` is the unmodified `Mac/include` folder of the Blackmagic DeckLink SDK 16.0 (April 2026),
Copyright (c) Blackmagic Design. Each file carries Blackmagic's own licence header, which permits use,
reproduction, distribution and sub-licensing provided the notice stays in every copy; the SDK EULA's
clause 0.1 additionally exempts these include files from the EULA's restrictive clauses. The rest of
the SDK (samples, documentation, binaries) is NOT included here and is not needed.

CamControl uses these headers for one thing: compiling an ffmpeg with the `decklink` input so the
program return from a Blackmagic capture device (UltraStudio / DeckLink / Intensity) can be shown on
the iPad remote. See `scripts/setup-ffmpeg-decklink.sh` and `docs/program-feed.md`. The resulting
binary links against Blackmagic Desktop Video, which operators install themselves from Blackmagic.
