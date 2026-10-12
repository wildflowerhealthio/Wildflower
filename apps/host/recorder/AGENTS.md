# AGENTS.md — apps/host/recorder

The **Recorder**: the host's Recorder tab, which opens a URL in the sniffer
webview, records every fetch/XHR response the injected `browser-sniffer`
reports, and writes a HAR 1.2 file into the recordings folder,
`Wildflower Recordings` (in Documents: the user's on the desktop, or their
Downloads where there is no Documents, the shared one on Android, the app's on
iOS; in the user's Downloads on the Mac App Store build, which is sandboxed),
when the recording stops. The file is what the Importer
opens. Designed in
[#652](https://github.com/wildflowerhealthio/Wildflower/issues/652); read the
[Design Explanation](./docs/Design%20Explanation.md) before changing anything
here.

It composes three existing primitives and adds nothing to their semantics:
`slices/browser-sniffer` (the injected shims and the webview lifecycle),
`apps/host/tauri-plugin-native-webview` (the presentation surface), and
`slices/file-formats/http-archive` (the one HAR emitter).

The host is its only consumer, in both languages, so every package sits here
as a group folder of `apps/host`, as `servers/` does. `apps/host/host-app`
mounts `RecorderPage` as its Recorder tab and attaches `recorder-tauri` in its
`setup()`.

## Package roles

- **[`recorder-core-js`](./recorder-core-js/AGENTS.md)** — the pure layer:
  `Recording` (sniffer events → `HttpArchive.Log`), `isOmittedFromRecording`,
  `recordingFileName`, `toHar`, `RecorderBridge`, and `readSaveFolder`, the
  `recorder_save_folder` command decoded as a `SaveFolder`. Platform-neutral.
- **[`recorder-react`](./recorder-react/AGENTS.md)** — `RecorderPage` and its
  `useRecorder` state machine, over `RecorderBridge` alone; the page shows the
  recordings folder and, where the platform can, Show file after a save.
- **`recorder-rust`** — serde mirror of the save channel (`bridge.rs`), the
  validated, atomic `save_har` (`save.rs`), and where each platform saves
  (`recordings_folder.rs`: `Platform`, `RecordingsLocation`, `SaveFolder`).
  No `tauri` dependency, so it compiles and tests without GTK.
- **`recorder-tauri`** — the host glue: `attach_recorder`, called from
  `host-app`'s `setup()`, resolves the recordings folder once through Tauri's
  path API and wires one `BRIDGE_EVENT` listener that decodes `SaveHar`,
  writes off the event thread, and answers `HarSaved` / `HarSaveFailed`; and
  the `recorder_save_folder` command, granted to the `main` webview by
  `host-app`'s `allow-recorder` permission.
- **`recorder-wire-golden.json`** — one wire payload per `RecorderBridge`
  tag and the `recorder_save_folder` answer, read by `recorder-core-js`'s and
  `recorder-rust`'s tests: change both sides with it.

## Rules

- **The folder is fixed per platform.** `Platform::recordings_locations` is
  the one place it is chosen; the page only shows it. There is no folder
  picker and nothing persisted. Show file goes through
  `tauri-plugin-opener`'s `revealItemInDir`, offered only where
  `Platform::reveals_files` says so (the desktop, sandboxed macOS included).
- **The Mac App Store build is told apart at run time.** It is the same binary
  as the Developer ID build, signed into the App Sandbox, so
  `Platform::current` reads the `APP_SANDBOX_CONTAINER_ID` macOS sets in a
  sandboxed process rather than a `cfg`.
- **A folder that can't be resolved doesn't stop the host.** The Recorder
  page says why, and every `SaveHar` is answered with `HarSaveFailed`.

## Layering

- **`recorder-core-js` is pure** — no DOM, no `fs`, no React, no Effect
  runtime. The page accumulates and builds the archive; Rust only writes
  bytes, so there is one HAR emitter and no `fs` grant to the web layer.
- **One bridge.** `RecorderBridge` carries the sniffer's data plane, the
  sniffer window's lifecycle and the save channel, with the tags and shapes
  `browser-sniffer-tauri` already routes and emits. Nothing here depends on
  the collector.
- **Intrinsic dependencies**: `browser-sniffer-core` (the data-plane
  schemas), `http-archive` (the format), `effect-messaging-core` (the bridge),
  `web-trace-core` (`contentTypeOf`, transitional until #578), and, for the
  React package, `effect-messaging-react`.
- **Nothing here is imported by the packages it builds on.**
  `browser-sniffer`, `file-formats` and the plugin know nothing about the
  recorder, and `servers-react` doesn't either: the host shell composes both.

## References

- [Design Explanation](./docs/Design%20Explanation.md) — the flow, where each
  piece lives and why, the decision table, and what is deliberately absent.
- [recorder-core-js AGENTS.md](./recorder-core-js/AGENTS.md) — the pure layer.
- [recorder-react AGENTS.md](./recorder-react/AGENTS.md) — the page and the
  state machine.
- [apps/host/AGENTS.md](../AGENTS.md) — the folder this group sits in.
- [http-archive AGENTS.md](../../../slices/file-formats/http-archive/AGENTS.md) — the HAR
  format the recorder emits through.
- [browser-sniffer AGENTS.md](../../../slices/browser-sniffer/AGENTS.md) — the capture
  primitive the recording is built from.
- [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md) — the
  TS ⇄ Rust discipline `RecorderBridge` follows.
