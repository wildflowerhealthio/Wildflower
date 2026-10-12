# AGENTS.md — apps/host/recorder

The **Recorder**: the host's Recorder tab, which opens a URL in the sniffer
webview, records every fetch/XHR response the injected `browser-sniffer`
reports, and writes a HAR 1.2 file into the recordings folder when the
recording stops. The file is what the Importer opens. Designed in
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
  `recordingFileName`, `toHar`, and `RecorderBridge`. Platform-neutral.
- **[`recorder-react`](./recorder-react/AGENTS.md)** — `RecorderPage` and its
  `useRecorder` state machine, over `RecorderBridge` alone.
- **`recorder-rust`** — serde mirror of the save channel (`bridge.rs`) plus
  the validated, atomic `save_har` and the recordings folder's name
  (`save.rs`). No `tauri` dependency, so it compiles and tests without GTK.
- **`recorder-tauri`** — the host glue: one `BRIDGE_EVENT` listener that
  decodes `SaveHar`, writes off the event thread, and answers `HarSaved` /
  `HarSaveFailed`. Attached from `host-app`'s `setup()`.
- **`recorder-wire-golden.json`** — one wire payload per `RecorderBridge`
  tag, read by `recorder-core-js`'s and `recorder-rust`'s tests: change both
  sides with it.

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
