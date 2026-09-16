# AGENTS.md — slices/har-recorder

The **HAR Recorder**: a desktop tool that opens a URL in the sniffer webview,
records every fetch/XHR response the injected `browser-sniffer` reports, and
writes a HAR 1.2 file into the app's `saved_data` directory when the recording
stops. The in-app cousin of the browser extension in #578 — same output format,
saved locally. Designed in [#652](https://github.com/wildflowerhealthio/Wildflower/issues/652);
read the [Design Explanation](./docs/Design%20Explanation.md) before changing anything here.

It composes three existing primitives and adds nothing to their semantics:
`slices/browser-sniffer` (the injected shims and the webview lifecycle),
`plugins/tauri-plugin-native-webview` (the presentation surface), and
`slices/file-formats/http-archive` (the one HAR emitter).

## Package roles

- **[`har-recorder-core`](./har-recorder-core/AGENTS.md)** — the pure layer:
  `Recording` (sniffer events → `HttpArchive.Log`), `isOmittedFromRecording`,
  `recordingFileName`, `toHar`, and `HarRecorderBridge`. Platform-neutral.
- **`har-recorder-rust`** — serde mirror of the bridge wire (`bridge.rs`) plus
  the validated, atomic `save_har` and the one Rust definition of the
  `saved_data` folder name (`save.rs`). No `tauri` dependency, so it compiles
  and tests without GTK.
- **[`har-recorder-react`](./har-recorder-react/AGENTS.md)** — the `/har-recorder`
  page and its `useHarRecorder` state machine. Intakes sniffer events through
  `collector-react`'s register/sender hooks (the data-plane tags live on
  `CollectorBridge`, and a tag must be unique across the shared channel), which
  makes `collector-react` an intrinsic dependency. The tab is contributed by the
  Tauri entry through `platformTabs`, so the recorder appears only where a
  sniffer webview and a host filesystem exist.
- **`har-recorder-tauri-rust`** — the host glue: one `BRIDGE_EVENT` listener
  that decodes `SaveHar`, writes off the event thread, and answers `HarSaved` /
  `HarSaveFailed`. Attached from `wildflower-tauri`'s `setup()`, which hands it
  the app data directory it already resolved.

## Layering

- **`har-recorder-core` is pure** — no DOM, no `fs`, no React, no Effect
  runtime. The SPA accumulates and builds the archive; Rust only writes bytes,
  so there is one HAR emitter and no `fs` grant to the web layer.
- **Intrinsic dependencies**: `browser-sniffer-core` (message types),
  `http-archive` (the format), `effect-messaging-core` (the bridge),
  `web-trace-core` (`contentTypeOf`, transitional until #578), and — for the
  React package — `collector-react`.
- **Nothing here is imported by the slices it builds on.** `browser-sniffer`,
  `collector`, `file-formats` and the plugin know nothing about the recorder.

## References

- [Design Explanation](./docs/Design%20Explanation.md) — the flow, where each
  piece lives and why, the decision table, and what is deliberately absent.
- [har-recorder-core AGENTS.md](./har-recorder-core/AGENTS.md) — the pure layer.
- [har-recorder-react AGENTS.md](./har-recorder-react/AGENTS.md) — the page and
  the state machine.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [http-archive AGENTS.md](../file-formats/http-archive/AGENTS.md) — the HAR
  format the recorder emits through.
- [browser-sniffer AGENTS.md](../browser-sniffer/AGENTS.md) — the capture
  primitive the recording is built from.
- [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) — the
  TS ⇄ Rust discipline `HarRecorderBridge` follows.
