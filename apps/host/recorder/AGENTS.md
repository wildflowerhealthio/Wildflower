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
renders `RecorderPage` at its `/recorder` route, under a `RecorderProvider`
its layout holds around every route, and attaches `recorder-tauri` in its
`setup()`.

## Package roles

- **[`recorder-core-js`](./recorder-core-js/AGENTS.md)** — the pure layer:
  `Recording` (sniffer events → `HttpArchive.Log`), `isOmittedFromRecording`,
  `recordingFileName`, `toHar`, `RecorderBridge`, `readSaveFolder`, the
  `recorder_save_folder` command decoded as a `SaveFolder`, and the bookmark
  commands decoded as `Bookmark`s, with `byRecency` and `bookmarkUrl`.
  Platform-neutral.
- **[`recorder-react`](./recorder-react/AGENTS.md)** — `RecorderPage`, and
  `RecorderProvider` running its `useRecorder` state machine, over
  `RecorderBridge` alone; the page shows the
  recordings folder and, where the platform can, Show file after a save, and
  lists the bookmarks through `useBookmarks`.
- **`recorder-rust`** — serde mirror of the save channel (`bridge.rs`), the
  validated, atomic `save_har` (`save.rs`), where each platform saves
  (`recordings_folder.rs`: `Platform`, `RecordingsLocation`, `SaveFolder`),
  and the bookmarks (`bookmarks.rs`: `JsonBookmarks` over
  `<data root>/recorder-bookmarks.json`, `Bookmark`, `BookmarkError`, the
  commands' `Bookmark*Args`). No `tauri` dependency, so it compiles and tests
  without GTK.
- **`recorder-tauri`** — the host glue: `attach_recorder`, called from
  `host-app`'s `setup()`, resolves the recordings folder once through Tauri's
  path API and wires one `BRIDGE_EVENT` listener that decodes `SaveHar`,
  writes off the event thread, and answers `HarSaved` / `HarSaveFailed`, and
  manages a `JsonBookmarks` in the data root `setup()` passes it; and the
  page's commands, granted to the `main` webview by `host-app`'s
  `allow-recorder` permission: `recorder_save_folder`, and
  `recorder_bookmarks`, `recorder_bookmark_add`, `recorder_bookmark_rename`,
  `recorder_bookmark_remove` and `recorder_bookmark_recorded`, each answering
  with every bookmark and doing its file IO on a blocking worker.
- **`recorder-wire-golden.json`** — one wire payload per `RecorderBridge`
  tag, the `recorder_save_folder` and `recorder_bookmarks` answers under
  `commands`, and one example of each bookmark change's arguments under
  `commandArgs`, read by `recorder-core-js`'s, `recorder-rust`'s and
  `browser-sniffer-tauri`'s tests: change both sides with it.

## Rules

- **The folder is fixed per platform.** `Platform::recordings_locations` is
  the one place it is chosen; the page only shows it. There is no folder
  picker. Show file goes through
  `tauri-plugin-opener`'s `revealItemInDir`, offered only where
  `Platform::reveals_files` says so (the desktop, sandboxed macOS included).
- **The Mac App Store build is told apart at run time.** It is the same binary
  as the Developer ID build, signed into the App Sandbox, so
  `Platform::current` reads the `APP_SANDBOX_CONTAINER_ID` macOS sets in a
  sandboxed process rather than a `cfg`.
- **Bookmarks are the one thing persisted.** `recorder-bookmarks.json` in the
  data root, owned by `recorder-rust`'s `JsonBookmarks`, beside
  `servers.json`. A bookmark is keyed by its exact URL, normalised by the
  page's `bookmarkUrl`. A missing file reads as `FIRST_RUN_BOOKMARKS`, and an
  existing one is never reseeded. Starting a recording stamps the bookmark at
  exactly that URL with the host's clock.
- **A folder that can't be resolved doesn't stop the host.** The Recorder
  page says why, and every `SaveHar` is answered with `HarSaveFailed`.

## Layering

- **`recorder-core-js` is pure** — no DOM, no `fs`, no React, no Effect
  runtime. The page accumulates and builds the archive; Rust only writes
  bytes, so there is one HAR emitter and no `fs` grant to the web layer.
- **One bridge.** `RecorderBridge` carries the sniffer's data plane, the
  sniffer window's lifecycle and the save channel, with the tags and shapes
  `browser-sniffer-tauri` already routes and emits. The recordings folder and
  the bookmarks are host commands, not bridge messages.
- **Intrinsic dependencies**: `browser-sniffer-core` (the data-plane
  schemas), `http-archive` (the format), `effect-messaging-core` (the bridge),
  `web-trace-core` (`contentTypeOf`, transitional until #578), and, for the
  React package, `effect-messaging-react` and `kitchen-sink`
  (`formatRelativeTime`).
- **Nothing here is imported by the packages it builds on.**
  `browser-sniffer`, `file-formats` and the plugin know nothing about the
  recorder, and `servers-react` doesn't either: the host app composes both.

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
