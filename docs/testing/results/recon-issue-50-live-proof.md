# Tracking packaged live-model and stop recon — 2026-10-01

Scope: the signed candidate built from3711a9e, not a source-stub detector.
Only a generated geometric JPEG and an owned loopback frame endpoint/virtual
gimbal were used. No camera footage, hardware or shipping files were changed.

## Observations before new assertions

`node scripts/test-tracking-sidecar-runtime.cjs --app <candidate.app> --recon`
retained `dist/tracking-live-recon-321352f4-d747-4ad6-9055-ca5a0d04d042.json`.
The live bundled helper emitted valid protocol messages: a positive inference
metric19.699ms, completed-frame age49ms, zero dropped/busy/invalid messages,
locking then idle and exactly the curated `no_target` code (no source error).
The actual socket received fresh stop commands after manual override0.325ms
and helper SIGKILL1.962ms; the virtual watchdog remained250ms.

## Codify and confirm

Independent review kept network-denied real-model execution and authenticated
protocol tests; REDO for the old idle-only detector implication and zero-velocity
watchdog inference. New assertions require a real authenticated frame, positive
finite inference metrics, strict message parsing, only `no_target`, actual
nonzero motion before interruption, a newly handled wire stop within200ms, and
no watchdog firing. Missing/invalid frame and source errors cannot pass as a
legitimate no-person result. No original safety threshold was weakened.

The confirm run exited0 and retained
`dist/tracking-runtime-evidence-612ca96c-b93e-4286-85f8-762ebe4bf995.json`:
22.664ms inference,55ms frame age, zero invalid messages, explicit stop0.510ms
on manual override and3.212ms on helper crash, one handled stop each and no
watchdog firing. Anonymous WebSocket/frame access was401/403.

This does not prove person-detection accuracy or physical motion safety.
Active-motion proof runs the actual packaged TS modules under test-host Node
with packaged Python and a virtual gimbal. The full installed Electron app's
separate helper/backend/parent/sleep/quit tests begin from idle, and must not be
described as installed-app active-person tracking. Final notarized-byte mounted
runtime reruns these proofs with the shipped files and actual Track UI click.
