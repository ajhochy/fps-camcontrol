# Plan — Device Config "rigs" redesign (three-column UI)

Status: **plan only, nothing implemented.** Written 2026-09-30.
Branch context: builds on `feat/sony-gimbal-link-and-link-watch` (gimbal link + Sony link watch).

## 1. Intent

**Goal (one sentence):** replace the long Device Config form with one screen where an operator builds and
inspects *rigs* (camera name + controller type + ATEM input + Sony camera), the ATEM connection and the Sony
camera connections, with live status beside whatever is selected.

**User decisions (2026-09-30):**

| Question | Decision |
| --- | --- |
| Layout | Three columns: list, inspector, live status & preview |
| Column 1 | Rigs, the ATEM connection(s), **one "Sony connections" item** (not one row per Sony camera), and a `+` to add (rig / ATEM / future NDI) |
| Sony connections item | Opening it shows the Sony management screen in the inspector: the service state, every named camera (name it, connect / reconnect / forget it), and newly found cameras to add and name. Rigs pick their camera from these names |
| Column 2 | Inspector: editing options for the selected rig / ATEM / Sony camera |
| Column 3 | Live status & preview: live preview, connection state, last error, quick actions (Retry, Forget) |
| Rig vs slot | Rigs replace the four camera slots. Profiles (Production / Test) stay as saved sets of rigs |
| Storage | `config/devices.yaml` stays the source of truth; the UI reads and writes it |
| Profiles in the UI | Profile management moves into this screen: a dropdown selects the active profile. Rig edits apply live to the **active profile as a working copy**; **Save as profile…** stores that working copy as a new profile and the original profile stays exactly as it was saved. The separate Profiles tab is retired |

**A rig** = ATEM input assignment + Sony camera (optional) + camera name + controller type
(`vbot`, `birddog`, or gimbal via `dji-bridge`).

**Terminology:** a *rig* is what the UI and this plan call one camera position. In `devices.yaml` it is an entry in a
profile's `slots:` list; the YAML key stays `slots` so existing files keep working and no migration is needed. A
profile is an ordered list of rigs.

**In scope:** Sony cameras as first-class inventory devices (`protocol: sony`) referenced from slots; the three-column layout; profile dropdown, save-as, rename and delete inside the same screen (replacing the Profiles tab); rig list/inspector/add/remove; ATEM and Sony inspectors (including the
existing Graphics settings, which are ATEM keyer settings); live status column; a rig-oriented API; moving the
camera-to-rig link into `devices.yaml`; tests.

**Out of scope / non-goals:** NDI streams (a disabled placeholder entry in `+` only); changing how controllers,
hotkeys, presets or the ATEM are driven; touch-focus
or other Sony features; any change to Sony SDK/sidecar behavior.

## 2. Hard constraints (from the code and the smoke suite)

1. **Comments in `devices.yaml` must survive every save** (issue #14). The writer already merges into the parsed
   YAML *Document* (`applyToDocument` in `src/config/configLoader.ts`). All new writes must go through it.
   Smoke assertions around `smokeTest.ts:1037–1070` guard this and must stay green.
2. **A save must never change a device's protocol** (issue #18: a protocol-blind save turned every DJI gimbal into
   VISCA). Smoke assertions around `smokeTest.ts:1000–1024` guard this. The rig API must address devices by key,
   not by list index.
3. **Camera ids are positional.** `resolveProfile` names slots `cam1..camN` by order, and that order is the
   face-button hotkey order (X / A / B / Y). `config/presets.json` is keyed by `cam1..cam4`. Reordering or
   deleting a rig therefore silently re-points presets and hotkeys unless handled (see risks).
4. The 228-assertion smoke suite and the 122-check Sony manager suite must keep passing.
5. `config/sony-cameras.json` holds per-machine *approval* (trust to auto-connect) and is deliberately untracked.
   No Sony credentials, fingerprints or pairing secrets are ever stored (existing rule).
6a. New schema rules this design needs: `protocol` gains `sony` for inventory devices only (`sonyCameraId` optional until bound); a `sony` device must never fill a slot's `device` (controller) and is never turned into a motion device; every place that lists inventory devices for a rig's controller (the Profiles tab device picker, `sonyGimbals`) must filter by protocol; a rig's `camera` must reference an existing `sony` device, may not be set on a BirdDog rig (`cameraType: birddog`, built-in camera), and two rigs in one profile may not use the same camera.
6. Data safety: no secrets in the UI payloads; the Sony sidecar has no authentication and stays on loopback.
7. Switching profiles is live: `POST /api/profiles/active` reconfigures cameras and moves the ATEM preview bus. A dropdown makes an accidental switch one click away, so it needs a guard (see D12 and risks).

## 3. How the current system works (investigation findings)

- `devices.yaml` has three levels: `atem`, an **inventory** of devices (`devices:` map; hardware, described
  once: `label`, `protocol`, `cameraType`, `viscaIp`, `bridge`, `speedScale`), and **profiles** (`profiles:` map;
  each has `slots: [{device, inputId?}]`), plus `activeProfile`. A legacy flat `cameras:` list is still accepted.
- `resolveProfile()` turns the active profile into the flat `cameras` list (`cam1..camN`) the app runs on.
- Device Config today posts that *resolved, index-aligned* list to `POST /api/config`; the server hydrates each
  entry from the inventory by index (`hydrateCameraPatches`) and writes back. This index coupling is what caused
  #14/#18 and is the main thing the new API should avoid.
- `POST /api/profiles` saves slot assignments; `POST /api/profiles/active` switches live; both call
  `reconcileCameras` to apply without restart. There is **no API to add or remove inventory devices** today.
- Sony: approval, connect, retry, forget and gimbal link live in `SonyManager` + `SonyStateStore`
  (`config/sony-cameras.json`); the dashboard renders them from `/api/sony/status`.
- The page is one template-literal script in `src/ui/statusServer.ts` (~2,600 lines); Device Config starts around
  the `// ---- Device Config Editor ----` marker. There is an existing rule that the 5 s poll must not clobber
  in-progress edits (Profiles tab `dataset.editing`).

## 4. Design decisions proposed (please confirm or change)

| # | Decision | Recommendation | Alternative |
| --- | --- | --- | --- |
| D1 | How is a Sony camera represented in `devices.yaml`? | As its **own inventory device**, like a gimbal: `devices.fx3: { label, protocol: sony, sonyCameraId: "78:F5:…" }`. A rig entry names both parts: `{ device: rs3, camera: fx3, inputId: 2 }`. `device` must be a motion controller (`visca` or `dji-bridge`); `camera` must be a `sony` device. The camera-to-controller pairing therefore lives in the **rig**, so it can differ per profile | A `sonyCamera` field on the gimbal device (my first proposal: one fixed pairing for all profiles) |
| D2 | The standalone gimbal link built on `feat/sony-gimbal-link-and-link-watch` | **Retired without migration.** It is unpushed and every link was cleared in testing. The rig's `device` + `camera` pair replaces it; `gimbalDevice` and its API route are removed from the Sony state store/manager/UI in issue 3 | Keep both (two sources of truth) |
| D3 | Sony approval (trust to auto-connect) | Stays in the local, untracked `sony-cameras.json`, keyed by the same camera id. Creating a Sony device entry does **not** approve it; connecting is still an explicit click. A camera that has been discovered but has no device entry appears in column 1 as "New camera: add as device" | Store approval in YAML (would commit camera trust) |
| D4 | Which rigs take a Sony `camera` | The rule follows the controller's `cameraType`: **V-BOT** and **gimbal (`dji-bridge`)** rigs take a Sony camera (expected, but optional so a rig can exist before its camera is assigned); **BirdDog** rigs have a built-in camera, so the Sony camera field is not offered and is rejected on save. The inspector shows "Built-in camera" for BirdDog rigs. `generic` VISCA devices are treated like V-BOT (field offered) | No rule (allow anywhere); or require a camera on every V-BOT/gimbal rig |
| D5 | Rig identity | A rig is addressed by its **device key** (`rs3`), never by position. Position only determines `camN` and the hotkey badge | Keep index addressing |
| D6 | Reorder / delete rigs | **v1: no drag-reorder.** Delete and add-at-end only; deleting shows which presets and hotkey it affects and requires confirmation. Reorder is a follow-up that also remaps `presets.json` | Ship reorder now |
| D7 | Legacy flat `cameras:` configs | Out of scope for editing; the screen shows a banner "legacy config: convert to profiles" and stays read-only. Your `production` config uses profiles | Edit both shapes |
| D8 | Graphics (DSK/USK) settings | Move into the **ATEM inspector** (they are ATEM keyer settings) | Keep as a separate section |
| D10 | What is per-profile and what is shared? | **Per profile (working copy):** which devices fill the rigs, their order, each rig's Sony camera and ATEM input. **Shared by every profile (saved immediately):** a device's hardware record: name, IP/bridge settings, and a Sony device's bound camera id. The inspector labels shared fields "shared by all profiles (N)" and saves them on change; they are not undone by reverting a profile | Snapshot and revert hardware records too (complex, and a wrong IP would bounce back) |
| D11 | How do edits, Save as, Save and Revert behave? | Rig edits (which device fills a rig, order, Sony camera, ATEM input) go into a **working copy** that is **applied to the running app immediately and saved across restarts** in `config/working-profile.json` (local, untracked, written atomically). The profile itself in `devices.yaml` is **not touched** until you save. The header shows `production • modified`. **Save** writes the working copy into the profile and clears the draft; **Save as profile…** writes it as a new profile, makes that profile active, clears the draft, and leaves the original profile exactly as it was saved; **Revert** drops the draft. On startup the app loads the draft over its base profile if one exists. Rename and delete are in the dropdown's menu; the last profile cannot be deleted | Persist edits straight into the profile and later restore it from a baseline snapshot (mutates the tracked file, and the baseline must also survive restarts) |
| D12 | Safety of switching profiles and of unsaved work | Switching asks for confirmation and lists the cameras that will change; if the ATEM program is on a camera that would change, it says so. Switching with unsaved changes offers **Save / Save as / Discard** (switching does not silently drop a draft). If the draft's base profile was deleted or renamed outside the app, startup ignores the draft, keeps it as `working-profile.json.orphaned-<time>`, and says so in the UI | In-memory draft only (rejected: a restart mid-service would lose rig changes) |
| D13 | Naming Sony cameras | A Sony device's `label` is its identifiable name, edited in the **Sony camera inspector** (for example "FX3 — stage left"). The rig inspector's camera dropdown lists Sony devices **by that name**, with the model and last 5 characters of the camera id as small secondary text, and marks unbound devices "No camera bound yet". Unnamed discovered cameras default to their model until named | Show raw model/MAC only |
| D14 | A Sony device before its camera is connected | A `sony` device entry may exist **without** a `sonyCameraId` ("No camera bound yet"), so you can set up all four rigs now and bind each camera when it is first discovered. The Sony inspector offers **Bind to discovered camera** from the discovered list. Rigs of type V-BOT or gimbal with no camera show a "No camera assigned" warning chip | Require the MAC id when creating the entry |
| D15 | Can a rig's controller type change after it exists? (user request, F3) | **Yes.** The rig inspector's Controller is a choice: V-BOT, BirdDog, DJI gimbal, Other VISCA-IP camera. Between VISCA kinds only `cameraType` changes. Between VISCA and a gimbal the connection is rebuilt on the same address with that kind's default port (bridge 7878; VISCA 52381, address 1), after a confirmation that names the new address and says presets recorded for the old kind will not recall (the device refuses a preset of the wrong kind, so it can never move the camera unexpectedly). Choosing BirdDog is refused while any profile has a Sony camera on that rig. It is a hardware change, shared by every profile | Keep the type fixed and make the operator remove and re-add the rig (loses its position, hotkey and presets) |
| D16 | Which gimbal a rig drives (user request, F3/F4) | **Chosen from the gimbals found, not typed.** Each gimbal has its own bridge (several instances on one Pi on ports 7878+, or later one Pi per gimbal). `GET /api/gimbals` lists every bridge found on the inventory's Pi hosts and, by a sweep of this machine's local /24 networks, on any other Pi, with the model it reports and whether a gimbal is attached. The rig inspector's **Gimbal** dropdown offers them (with the config name for a port already set up); choosing one sets the rig's bridge host and port. A gimbal another rig of the profile drives is shown but disabled, and the server refuses two rigs on one bridge. Safety: the Pi bridge stops its gimbal when a client disconnects, so the scan never probes a port the app drives (matched by name and address) and the sandbox turns the sweep off (`CAMCONTROL_GIMBAL_SWEEP=0`). The gimbal model is only a label filled from the report | A typed host and port, or a model list (the model does not identify a gimbal) |
| D9 | Third column and Sony live preview | Reuse the existing Sony dashboard polling and frame endpoint. A rig with a Sony camera (V-BOT or gimbal) shows that camera's preview; a BirdDog rig shows connection state only (its built-in camera has no preview endpoint here) | Add BirdDog previews (not available today) |

## 5. Prior art (research swarm)

- **YAML editing without losing comments (Node):** the `yaml` package Document API is the only mature option and is
  already what this repo uses. Known gotchas: comments survive but indentation/blank lines can normalize; inline
  comments inside *flow* sequences (`[a, b]`) can be lost; write atomically (temp file + rename) so a crash or
  concurrent editor can't leave a half-written config. Sources:
  [yaml Documents API](https://github.com/eemeli/yaml/blob/main/docs/04_documents.md),
  [discussion #510](https://github.com/eemeli/yaml/discussions/510),
  [issue #443](https://github.com/eemeli/yaml/issues/443).
  **Takeaway:** keep `applyToDocument`; change the final write to atomic temp+rename (today it is a direct
  `writeFileSync`).
- **Master-detail UI patterns (5b):** research summary, not verified against a built prototype. Sources:
  [ARIA listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/),
  [Material list-detail](https://m3.material.io/foundations/layout/canonical-examples/list-detail),
  [Apple WWDC21 iPad keyboard navigation](https://developer.apple.com/videos/play/wwdc2021/10260/),
  [Nielsen Norman tablet UX](https://www.nngroup.com/reports/tablets/).
  - Model column 1 as a `role="listbox"` (one Tab stop, arrow keys to move, `aria-selected`); Enter moves focus to
    the inspector heading.
  - Collapse by width: side-by-side at roughly 840 px and up, single pane below; test on a real tablet, not a
    scaled phone layout.
  - Gotchas to design for: focus is lost when a pane re-renders (restore it to the list row or inspector heading);
    selection can change before an input blurs (guard with a dirty-state check and an explicit save/discard
    prompt); live polling must not overwrite an inspector that has focus.
  - **Takeaway for the plan:** poll only columns 1 and 3; the inspector owns an edit draft; confirm before
    switching selection with unsaved changes. The repo already has this rule for the Profiles tab.

## 6. Cheapest version that proves the idea

Read-only three columns on today's config: list built from the resolved rigs + ATEM + Sony cameras, inspector shows
the selected item's fields read-only, third column reuses the existing Sony widget for status/preview. No API
changes, no writes. This validates the layout and selection/polling behavior before anything can corrupt config.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Comment loss on save (#14) | Only `applyToDocument`; keep and extend the comment-count assertions to every new write path |
| Protocol silently changed on save (#18) | Address by device key; protocol is read-only after creation in v1; keep the assertions |
| Per-rig comments in the YAML (`# slot 2 = A`) after add/delete | Verified: the writer merges slots by position, so position comments stay on their position and only the now-missing last slot loses its comment. A comment that describes one specific device would follow the position, not the device; the hotkey-order comments in use are position comments |
| Presets/hotkeys point at the wrong camera after add/delete | No reorder in v1; delete confirms and lists affected presets; add appends only |
| Half-written config on crash / concurrent hand edit | Atomic write; re-read the file before merge; reject if it changed since the UI loaded it (etag/mtime) |
| 5 s poll re-renders the inspector mid-edit (lost keystrokes, lost focus) | Inspector owns a draft; polling updates only columns 1 and 3; never replace an input that has focus |
| Two save paths (`/api/config` and `/api/profiles`) drift | New rig API is the only path the new screen uses; old endpoints stay for the old page until removed |
| Accidental profile switch during a service cuts or re-points cameras | Confirmation with the list of changed cameras and an ATEM-program warning; the active profile name and a `modified` badge are always visible at the top of column 1 |
| Draft file out of sync with `devices.yaml` (base profile changed or deleted by hand) | Draft records its base profile and the file version it was based on; startup validates it against the inventory, and an unusable draft is set aside (never deleted) with a message |
| Live working copy differs from the saved profile, so what is running is not what the file says | Header badge `modified`, a "what changed" list (rigs added/removed/changed), Save / Revert always one click away |
| Editing a shared device changes other profiles and is not undone by Revert | Inspector labels such fields "shared by all profiles (N)"; hardware edits save immediately and say so |
| Invalid rig saved live (bad IP, duplicate input) | Validate with the existing zod schemas before writing; apply via `reconcileCameras` only after the write succeeds |
| Unusable on a tablet | Collapse to two columns, then one, below set widths (see section 5b) |
| Data safety | No secrets displayed; Sony approval remains machine-local |

## 8. Issue breakdown

| Order | Title | Goal | Likely files | Tests / evaluation | Dependencies |
| --- | --- | --- | --- | --- | --- |
| 1 | Atomic, conflict-safe devices.yaml writes | Write via temp file + rename; re-read and refuse if the file changed since the client loaded it; no behavior change otherwise | `src/config/configLoader.ts` | New test: crash-simulated partial write leaves old file intact; stale-etag save rejected; all existing #14/#18 smoke assertions green | none |
| 2 | Rig model and read API | `GET /api/rigs`: resolved rigs with device key, label, controller type, inputId, hotkey badge, Sony camera, status; plus ATEM and Sony camera lists | `src/config/configLoader.ts`, `src/ui/statusServer.ts` | Unit tests for shape incl. unwired (no inputId) and dji-bridge rigs; no secrets in payload | none |
| 3 | Sony camera as an inventory device | Add `protocol: sony` + `sonyCameraId` to the inventory schema and an optional `camera` on rigs (profile slot entries), with the validation in constraint 6a; filter device pickers by protocol; remove the standalone `gimbalDevice` link (D2); approvals stay local | `src/config/configLoader.ts`, `src/sony/sonyStateStore.ts`, `src/sony/sonyManager.ts`, `src/ui/statusServer.ts` | Schema tests (valid/invalid references, duplicate camera, sony device as controller rejected); resolved cameras unchanged for existing configs; Sony manager suite green (c14 replaced); comment-preservation assertion after a save | 1, 2 |
| 4 | Rig write API (edit) | `PATCH /api/rigs/:deviceKey` for name, inputId, connection fields and the rig's `camera`; `POST/PATCH/DELETE` for `sony` devices (name, camera id); validate with zod; merge via `applyToDocument`; live-apply | `src/ui/statusServer.ts`, `src/config/configLoader.ts` | Smoke: edit keeps comments, keeps protocol, rejects duplicate inputId / bad host / same camera on two rigs / unknown camera key / a camera on a BirdDog rig; accepts a camera on a V-BOT rig and on a gimbal rig; a V-BOT or gimbal rig with no camera is valid | 1, 2, 3 |
| 5 | Rig add / delete API | `POST /api/rigs` (create inventory device + append slot to the active profile), `DELETE` with impact report (presets, hotkey) and confirm token | same | Tests: add appends as next `camN`; delete returns affected presets; presets untouched until confirmed; comments preserved | 4 |
| 6 | Three-column shell (read-only) | New Device Config layout: list / inspector / status; selection, keyboard nav, responsive collapse, no-clobber polling | `src/ui/statusServer.ts` (page script + CSS) | `check-page-js`, smoke assertions for structure; browser check at desktop / tablet / mobile widths | 2 |
| 7 | Inspectors (edit) | Rig inspector (name, connection, ATEM input, Sony camera picked by name); ATEM inspector (IP, transition, M/E, graphics); **Sony connections screen** (service status and retry; per camera: rename, Connect / Retry / Forget, bind a found camera to a named device; add a found camera as a new named device), "No camera assigned" warning chips | `src/ui/statusServer.ts` | Browser test: edit, save, reload; unsaved-draft guard when selection changes | 4, 6 |
| 8 | Live status column | Preview, connection state, last error, Retry/Forget for the selected rig or Sony camera | `src/ui/statusServer.ts` | Browser check with Sony fixture; existing Sony widget behavior unchanged | 6 |
| 9 | "+" menu and add/remove flows | Add rig, add ATEM, disabled "NDI stream (soon)"; delete confirmation with impact list | `src/ui/statusServer.ts` | Browser test of add + delete incl. confirmation text | 5, 7 |
| 9a | Profile and working-copy API | Keep a working copy of the active profile in `config/working-profile.json` (atomic write, applied live via `reconcileCameras`, loaded on startup, `.gitignore`d; the profile in the YAML is not written). Endpoints: `GET` working state + `modified` flag + change list; `POST .../save` (overwrite), `.../save-as` (new profile from working copy, activate it, original untouched), `.../revert`, rename, delete (refuse the last); writes via `applyToDocument` | `src/ui/statusServer.ts`, `src/config/configLoader.ts` | Smoke: edits do not touch the YAML until save; the draft survives a simulated restart and is applied on load; an orphaned draft is set aside; save-as creates the new profile and the original is byte-identical to before (comments intact); revert restores the running cameras; delete of the last/active profile refused; production/test fixture survives | 1, 2 |
| 9b | Profile dropdown, modified badge, Save / Save as / Revert, orphaned-draft notice | Dropdown at the top of column 1, `modified` badge, switch confirmation and unsaved-changes prompt (D12), rename/delete menu, "shared by all profiles" labels | `src/ui/statusServer.ts` | Browser test: edit → modified → Save as → new profile active and original unchanged on switching back; discard; revert | 6, 9a |
| 10 | Retire old section, gimbal dropdown and Profiles tab | Remove the old ATEM/Sony/Cameras blocks, the standalone gimbal dropdown and the Profiles tab after parity | `src/ui/statusServer.ts`, `src/testing/smokeTest.ts` | Full smoke + manual checklist below | 7, 8, 9, 9b |
| F1 | (follow-up) Reorder rigs with presets remap | Drag reorder that moves `presets.json` entries and shows hotkey badges | `configLoader.ts`, `statusServer.ts`, presets manager | Tests on preset remap | 10 |
| F2 | (follow-up) NDI stream connections | Real inspector for NDI sources | TBD | TBD | 10 |
| F3 | (follow-up, done) Changeable controller type; gimbal chosen from the bridges found (F4: on any Pi) | D15, D16 | `rigEdit.ts`, `rigs.ts`, `state.ts`, `djiBridgeDevice.ts`, `statusServer.ts` (reconcile ignores the model label), `ui/rigs/*` | rigEditTest, rigsTest, rigsUiModelTest, sandbox self-test (controller round trip live; a model change keeps the bridge connected) | 10 |

Suggested first slice (issues 1 and 2 are done): issues 6 (safe foundation, read-only screen you can look at), then 3–5, 7–8, 9, 9a–9b, 10.

## 9. Manual checks (after issue 10; need real hardware)

1. Edit a gimbal rig's name and ATEM input; reload; values persist; `devices.yaml` comments intact (diff the file).
2. Create a Sony device for the FX3A, put it in a rig's `camera` field (try the V-BOT rig and a gimbal rig; confirm a BirdDog rig offers no camera field), power-cycle it; column 1 shows it under that rig and it reconnects. Put it on a different rig in a second profile; switching profiles moves it.
3. Add a new rig; it becomes `cam5`-style next slot; presets for existing rigs unchanged.
4. Delete a rig; confirmation lists the presets and hotkey it affects.
5. Tablet-width layout usable with touch.
6. Edit a rig (header shows `modified`), Save as a new profile, switch back to the original: it is exactly as it was before the edits. Switching with unsaved changes offers Save / Save as / Discard; the switch confirmation appears.
7. Create Sony devices for all four cameras before they are connected; each shows "No camera bound yet"; connect one, bind it from the discovered list, and the rig's warning chip clears.

## 10. Open questions for the user

- Confirm D1–D12 above (especially D1 as updated, D3 and D6).
- Should deleting a rig also delete its inventory device (hardware description) or keep it available to re-add?
- D10–D13 record your answer (live working copy, Save as creates a new profile, original untouched). Confirmed 2026-09-30: the working copy is saved across restarts and applied immediately (D11/D12); hardware details (name, IP, bound Sony camera) are shared by all profiles and save immediately (D10).

## 11. API as built (issues 2-4)

| Call | Purpose |
| --- | --- |
| `GET /api/rigs` | Rig view: `rigs[]` (position, id, deviceKey, label, controller, visca/gimbal connection, speedScale, inputId, hotkey, builtInCamera, camera, cameraLabel, usedInProfiles, live), `sonyDevices[]`, `unboundCameras[]`, `profiles[]`, `atem`, `graphics`, `sony`, `version`, `legacy`. Also returned by every edit below |
| `PATCH /api/rigs/:deviceKey` | Body: any of `label`, `speedScale`, `visca:{host,port,address}`, `gimbal:{host,port,gimbalModel,safetyTimeoutMs,rollEnabled,reconnectBackoffMs}`, `inputId` (null = control-only), `camera` (Sony device key or null), `position` (only when one device fills several rigs), `expectedVersion`. `controller` (`vbot` / `birddog` / `gimbal` / `generic`) changes the controller type and is applied before `visca` / `gimbal` (F3, D15); `protocol` and `cameraType` cannot be sent directly. The rig view's `gimbal.reportedModel` is what the bridge reports. Unknown fields are refused, not ignored |
| `POST /api/rigs` | Add a rig at the end of the active profile (existing rigs never move). Either `{deviceKey, inputId?, camera?}` (put an existing inventory controller on a new rig) or `{label, controller: vbot\|birddog\|gimbal\|generic, visca:{host,port?,address?} \| gimbal:{host,port?,gimbalModel?}, speedScale?, inputId?, camera?}` (new hardware; the device key is made from the name). 201 with `key`, `position` and the new rig view |
| `DELETE /api/rigs/:deviceKey` | Body `{position?, deleteDevice?, confirm?, expectedVersion?}`. Without `confirm: true` the answer is **409 `confirmationRequired`** with `impact` (presets that would be lost, later rigs that move up with their old and new camera id and hotkey, other profiles using the hardware) and nothing changes. With it: the slot is removed, **later rigs' presets shift down one place** (`presets.json` is rewritten atomically), control is re-pointed if needed. The hardware entry stays in the inventory unless `deleteDevice: true` (refused with 409 while another rig in any profile uses it). The last rig of a profile cannot be removed |
| `POST /api/sony-devices` | `{label, sonyCameraId?}` -> 201 with the new `key` (made from the name, unique) |
| `PATCH /api/sony-devices/:key` | `{label?, sonyCameraId?}`; `sonyCameraId: null` unbinds |
| `DELETE /api/sony-devices/:key` | 409 while any rig in any profile uses it |
| errors | 400 invalid (message says why), 404 unknown device, 409 stale `expectedVersion` (`conflict: true`) or device in use |

Every edit: validated as a whole file (same rules as load) before anything is written -> written through the
comment-preserving writer (atomic, version-checked) -> re-read from disk -> applied to the running cameras.

**Interim behaviour:** until issue 9a, wiring edits (`inputId`, `camera`) are written straight into the active
profile in `devices.yaml`. Issue 9a moves them into the working copy (D11) and makes hardware fields the only
immediate writes. Removing or adding a rig renumbers nothing before it; removing rig N renumbers every later rig (`camN` ids, hotkeys), which is why delete needs `confirm`. The running cameras of shifted rigs reconnect briefly. Not built yet: any UI.

### Working copy and profiles (issue 9a, as built)

Rig wiring edits (`inputId`, `camera`, add rig, remove rig) are a **working copy** of the active profile:
applied to the running app at once and saved in `config/working-profile.json` (local, untracked, atomic write) so they
survive a restart; the profile in `devices.yaml` is untouched until saved. Hardware edits (names, addresses, ATEM,
Sony devices) are not part of it and still save immediately. `GET /api/rigs` adds
`profile: { active, modified, changes[], notice }`; `changes[]` are `added | removed | moved | input | camera`
entries matched by device. On startup `loadConfig` applies the working copy; one that cannot be restored (profile
deleted, device gone, invalid) is set aside as `working-profile.json.orphaned-<time>` and reported in `profile.notice`.

| Call | Purpose |
| --- | --- |
| `POST /api/profiles/save` | Write the working rigs into the active profile; ends the working copy |
| `POST /api/profiles/save-as` `{label}` | New profile (key from the name, name must be unique) with the working rigs, made active; the original stays exactly as saved. 201 with `key` |
| `POST /api/profiles/revert` | Drop the working copy, restore the presets snapshot taken when the edits began (presets are keyed by rig position) |
| `POST /api/profiles/active` `{profile, discard?}` | Switch; **409 `unsavedChanges`** with `changes` when there is a working copy unless `discard: true` (which drops it and restores the presets) |
| `PATCH /api/profiles/:name` `{label}` / `DELETE /api/profiles/:name` | Rename; delete (the active profile and the last profile are refused with 409) |

Also: the classic Device Config and Profiles tab saves answer 409 while a working copy exists (they would write rigs
behind it). Deleting a hardware entry together with a rig is refused while the profile is unsaved (the saved profile
still lists it); the device stays in the inventory. A Sony device that the working copy uses cannot be deleted.

### Retiring the old screens (issue 10, as built)

The old Device Config tab (ATEM, Sony, Graphics, Cameras editors) and its code are removed; the rigs screen is now the
**Device Config** tab and also holds the Dark mode switch that lived in the old panel. The standalone gimbal dropdown
was already removed in issue 3. `POST /api/config` and `POST /api/profiles` remain as API routes (the smoke suite uses
them) but nothing in the page calls them.

**Kept on purpose: the Profiles tab, renamed "Profiles (classic)".** The new screen cannot yet reorder rigs or change
which device fills a rig (follow-up F1), and the old Profiles tab can. Retire it when F1 lands. Also not carried over:
changing a VISCA camera's controller type (V-BOT / BirdDog / generic) after it exists; the new screen keeps the
controller type read-only by design (issue #18 turned gimbals into VISCA cameras when a form guessed the protocol).
Edit it in `devices.yaml` if it ever needs to change.
