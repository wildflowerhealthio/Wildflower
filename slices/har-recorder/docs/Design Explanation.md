# HAR Recorder — Design Explanation

Why the HAR Recorder is shaped the way it is: what it composes, where each
decision landed, and what was deliberately left out. The decision table was
confirmed by the maintainer in [#652](https://github.com/wildflowerhealthio/Wildflower/issues/652);
this document is the durable version of it.

## What it is

A desktop tool in the Wildflower app. The **HAR Recorder** tab opens a URL in
the `tauri-plugin-native-webview` sniffer instance, keeps every fetch/XHR
response the injected `browser-sniffer` reports, lets the page's own downloads
land on disk, and writes a HAR 1.2 file into `<app data dir>/saved_data` when
the recording stops.

It composes three existing primitives and adds nothing to their semantics:

- [`slices/browser-sniffer`](../../browser-sniffer/AGENTS.md) — the injected
  shims and the `Open` / `SniffingComplete` / `UserDismissed` lifecycle.
- [`plugins/tauri-plugin-native-webview`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md)
  — the presentation surface, which gained a per-instance **download
  directory** for this feature.
- [`slices/file-formats/http-archive`](../../file-formats/http-archive/AGENTS.md)
  — `HttpArchive.Log`, `emitHarFromLog`, `harToJson`: the one HAR emitter.

It is the in-app cousin of epic #578's browser extension (#600): same output
format, recorded through the native webview and saved locally rather than to
Downloads or the server. It is meant to replace `web-trace-collector`'s
hand-driven flow over time; it does not touch `slices/web-trace`.

## The flow

```text
[HAR Recorder page, main SPA webview]         [Tauri host]                    [sniffer native webview]
  Start(url)
  ├─ register CollectorBridge handlers
  └─ send Open { source: Uri(url) } ─────────▶ browser-sniffer-tauri-rust
                                               open_or_navigate("sniffer",
                                                 download_dir = saved_data) ──▶ builds/navigates, injects sniffer
                                                                                 page fetch/XHR → ResponseStart /
  Recording.onResponse*(…) ◀──── BRIDGE_EVENT ◀── data-plane allowlist ◀────── ResponseData / ResponseFinished
  count++ on ResponseFinished
                                                                                 user clicks a download link
                                               on_download → saved_data/<name> ◀─ DownloadEvent
  Stop & Save   (or UserDismissed from a window close)
  ├─ toHar(recording) → harToJson → text
  ├─ send SaveHar { fileName, text } ────────▶ har-recorder-tauri-rust
  │                                             spawn_blocking(save_har) → tmp + rename
  │  HarSaved { path } / HarSaveFailed ◀─────── emit on BRIDGE_EVENT
  ├─ send SniffingComplete ──────────────────▶ browser-sniffer-tauri-rust → dispose()
  └─ unregister handlers
```

Order matters twice. Handlers are registered **before** `Open`, so the
sniffer's first events cannot land on a dropped receiver. `SaveHar` goes out
**before** `SniffingComplete`, because `SniffingComplete` is what tears the
sniffer webview down and the host must hold the bytes first.

## Where each piece lives, and why

| Piece                         | Home                                       | Why there                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accumulating responses        | `har-recorder-core` (`Recording`)          | Pure and synchronous; testable by feeding message sequences. Holds body bytes as a mutable class because rebuilding per chunk would copy megabytes per event.                    |
| Building the HAR              | `har-recorder-core` (`toHar`)              | Delegates to `http-archive`'s `emitHarFromLog`, so there is **one** HAR emitter. Two additive options (`creatorName`, `requestComment`) let the recorder name itself.            |
| Writing the file              | `har-recorder-rust` (`save_har`)           | The SPA has no `fs` grant and should not get one; Rust validates the name before any filesystem call, writes to a temp file and renames, and refuses to overwrite.               |
| Carrying the text to the host | `HarRecorderBridge`                        | Bridge messages are the repo's SPA→host pattern. The archive rides as already-encoded text so the host needs no HAR model.                                                       |
| Receiving sniffer events      | `har-recorder-react` on `CollectorBridge`  | The data-plane tags are declared on `CollectorBridge` and tags must be unique across bridges, so the recorder registers through `collector-react`'s hooks. Intrinsic dependency. |
| The tab                       | `apps/wildflower-tauri` via `platformTabs` | The route exists in every build; only the Tauri entry contributes the tab, the same way it contributes `platformSettingsItems`.                                                  |
| Downloads                     | `tauri-plugin-native-webview`              | The `on_download` hook must be set when the content webview is built, so the plugin owns it; the sniffer passes `saved_data` on every open.                                      |

## Decisions

| Topic        | Decision                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request side | Response-only. Entries carry `method: UNKNOWN`, no request headers or body, and a `comment` saying why. Request-side capture is #440. (The sniffer's `ResponseStart` does carry an observed `method`; using it needs an `emitHarFromLog` change and is a follow-up.) |
| Filter       | Drop `text/css`, `image/*`, `video/*`, `audio/*`, `font/*` by response content type. **JavaScript is kept**, deliberately diverging from #578's `isOmittedContentType`; the recorder owns `isOmittedFromRecording` permanently.                                      |
| DOM snapshot | `PageLoaded`'s DOM body arrives as an ordinary Start/Data/Finished triple and is recorded like any other response.                                                                                                                                                   |
| Body cap     | 5 MB per body (`MAX_BODY_BYTES`). Over-cap entries stay in the archive as `bodyAbsent` with a comment; the true byte count survives only on `Recording.observedBodyBytes`, because `HttpArchive.Entry` has no size field.                                            |
| Naming       | Flat: `saved_data/<YYYY-MM-DDTHH-mm-ssZ>-<host>.har`, host reduced to `[a-z0-9.-]`, at most 200 characters. The 200 bound is stated on both sides (TS producer, Rust validator); drift is fail-safe because the host is the stricter one.                            |
| Collisions   | The host refuses to overwrite an existing target (`AlreadyExists`) rather than clobbering.                                                                                                                                                                           |
| Instance     | Shares the `sniffer` native-webview instance with collector imports. No guard: running both at once is a documented limitation.                                                                                                                                      |
| Lifecycle    | Start, Stop & Save, and a window close (`UserDismissed`) all end the recording the same way. `stop()` is idempotent, and unmounting mid-recording still sends `SniffingComplete` so no window is orphaned.                                                           |
| Downloads    | Desktop only, deliberate user downloads only (attachments and non-renderable navigations). Always enabled for the sniffer instance. Files land flat in `saved_data/`; nothing in the HAR references them. Mobile backends emit no download events.                   |
| Delivery     | One branch, one commit per phase, one draft PR.                                                                                                                                                                                                                      |

## What the sniffer cannot see

The sniffer shims `fetch` and `XMLHttpRequest`. It never sees `<img>`,
`<link>`, `<script>` or document navigations, and it observes no request
headers or body. The content-type filter above therefore applies to fetch/XHR
responses only; the omitted types mostly matter when a page fetches media
through XHR. A recording is honest about this in its `log.comment` and every
entry's `request.comment`.

## Verification limits

The desktop Tauri crates link `webkit2gtk`, which the Linux dev container does
not have, so `tauri-plugin-native-webview`, `browser-sniffer-tauri-rust`,
`har-recorder-tauri-rust` and the app crate are compiled only in CI
(`ci-rust.yml`). Everything with logic worth testing was placed where a plain
`cargo test` runs: `har-recorder-rust` has no `tauri` dependency, and the
plugin's download-name sanitiser is a tauri-free module. `scripts/checks/rust.sh`
lists `har-recorder-tauri-rust` in its Tauri partition so the GTK-less
pre-commit keeps skipping it locally.

## Deliberately not here

- Mobile downloads (`WKDownloadDelegate` / `DownloadListener`).
- Request-side capture (#440) and real request methods in the archive.
- A recordings list or an Open Folder action.
- A busy guard between the recorder and a collector import.
- Anonymization — the Importer's Anonymize tab (#578 A1–A3) consumes the file.

## Where to look next

- `har-recorder-core/src/recording.ts` — the accumulator and its rules.
- `har-recorder-react/src/use-har-recorder.ts` — the state machine and ordering.
- `har-recorder-rust/src/save.rs` — name validation and the atomic write.
- `plugins/tauri-plugin-native-webview/src/desktop/lifecycle.rs` — the download hook.
