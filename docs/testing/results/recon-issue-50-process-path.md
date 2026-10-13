# Mounted tracking process-path recon — 2026-10-01

Candidate source3711a9e; DMG SHA256
bc9b562873cc234ea98d7b4d0e5801967c333d6c6657610081e9169bdc011f9a.
Exact mounted harness reproduced its zero-child assertion in two separate runs:
runtime-2026-10-01T20-24-41-917Z and runtime-2026-10-01T20-25-33-524Z.
Both reached connected live-helper API state; generated-model proof completed.

Read-only `/bin/ps -ww -axo pid=,ppid=,comm=` during the second run observed:

- Electron parent2037, utility backend2041 with PPID2037.
- Bundled Python2044 with PPID2041 and executable prefix
  `/private/var/folders/.../fps tracking mounted runtime Q85cmq/Mounted DMG/FPS CamControl Tracking.app/Contents/Resources/python/bin/python3`.
- Harness resources used `/var/folders/...` for the same mounted files.
- Earlier direct bundled-Python test processes used `/var/folders/...` names.

No command arguments or environments were inspected. No hardware was opened.
This is an observed filesystem alias mismatch in the test ownership filter,
not evidence of a missing backend child. The exact parent PID and exactly-one
bundled-interpreter requirements must remain unchanged. Canonicalize paths;
do not broaden to arbitrary Python processes or kill by process name.
