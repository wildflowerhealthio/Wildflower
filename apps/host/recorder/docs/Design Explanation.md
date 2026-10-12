# Recorder — Design Explanation

Why the Recorder is shaped the way it is: what it composes, where each
decision landed, and what was deliberately left out. The decision table was
confirmed by the maintainer in [#652](https://github.com/wildflowerhealthio/Wildflower/issues/652);
this document is the durable version of it.

## What it is

The host's **Recorder** tab. It opens a URL in the
`tauri-plugin-native-webview` sniffer instance, keeps every fetch/XHR response
the injected `browser-sniffer` reports, lets the page's own downloads land on
disk, and writes a HAR 1.2 file into the recordings folder,
`Wildflower Recordings`, when the recording stops. The Importer opens the
file.

It composes three existing primitives and adds nothing to their semantics:

- [`slices/browser-sniffer`](../../../../slices/browser-sniffer/AGENTS.md) — the injected
  shims and the `Open` / `SniffingComplete` / `UserDismissed` lifecycle.
- [`apps/host/tauri-plugin-native-webview`](../../tauri-plugin-native-webview/docs/Explanation.md)
  — the presentation surface, with a per-instance **download directory**.
- [`slices/file-formats/http-archive`](../../../../slices/file-formats/http-archive/AGENTS.md)
  — `HttpArchive.Log`, `emitHarFromLog`, `harToJson`: the one HAR emitter.

It is the in-app cousin of epic #578's browser extension (#600): same output
format, recorded through the native webview and saved on the device rather
than on the server. It is meant to replace `web-trace-collector`'s
hand-driven flow over time; it does not touch `slices/web-trace-core`.

## The flow

```text
[Recorder tab, main webview]                  [Tauri host]                    [sniffer native webview]
  mount: register RecorderBridge handlers,
         read recorder_save_folder ──────────▶ recorder-tauri
  Start(url)
  └─ send Open { source: Uri(url) } ─────────▶ browser-sniffer-tauri
                                               open_or_navigate("sniffer",
                                                 download_dir = saved_data) ──▶ builds/navigates, injects sniffer
                                                                                 page fetch/XHR → ResponseStart /
  Recording.onResponse*(…) ◀──── BRIDGE_EVENT ◀── data-plane allowlist ◀────── ResponseData / ResponseFinished
  count++ on ResponseFinished
                                                                                 user clicks a download link
                                               on_download → saved_data/<name> ◀─ DownloadEvent
  Stop & Save   (or UserDismissed from a window close)
  ├─ toHar(recording) → harToJson → text
  ├─ send SaveHar { fileName, text } ────────▶ recorder-tauri
  │                                             spawn_blocking(save_har) → tmp + rename
  │  HarSaved { path } / HarSaveFailed ◀─────── emit on BRIDGE_EVENT
  └─ send SniffingComplete ──────────────────▶ browser-sniffer-tauri → dispose()
  Show file (desktop) → revealItemInDir(path)
```

Order matters twice. The handlers are registered when the page mounts, so
they are in place before any `Open` and the sniffer's first events cannot land
on a dropped receiver; they stay until it unmounts, so `HarSaved` still finds
them after the window has closed. `SaveHar` goes out **before**
`SniffingComplete`, because `SniffingComplete` is what tears the sniffer
webview down and the host must hold the bytes first.

## Where each piece lives, and why

| Piece                  | Home                             | Why there                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accumulating responses | `recorder-core-js` (`Recording`) | Pure and synchronous; testable by feeding message sequences. Holds body bytes as a mutable class because rebuilding per chunk would copy megabytes per event.                                                                                                                                                           |
| Building the HAR       | `recorder-core-js` (`toHar`)     | Delegates to `http-archive`'s `emitHarFromLog`, so there is **one** HAR emitter. Two additive options (`creatorName`, `requestComment`) let the recorder name itself.                                                                                                                                                   |
| Writing the file       | `recorder-rust` (`save_har`)     | The page has no `fs` grant and should not get one; Rust validates the name before any filesystem call, writes to a temp file and renames, and refuses to overwrite.                                                                                                                                                     |
| Choosing the folder    | `recorder-rust` (`Platform`)     | A pure function of the platform and the directories Tauri resolves, tested without a webview; `recorder-tauri` resolves them once at startup and answers `recorder_save_folder`. The sandboxed Mac App Store build is detected at run time (`APP_SANDBOX_CONTAINER_ID`), since it is the Developer ID binary re-signed. |
| The wire               | `RecorderBridge`                 | One bridge for the sniffer's data plane, the window's lifecycle and the save, with the tags `browser-sniffer-tauri` already routes. The archive rides as encoded text, so the host needs no HAR model.                                                                                                                  |
| The page               | `apps/host/host-app`             | The host's `/recorder` route, beside the base's routes in its one router, over an `effect-messaging-tauri-js` transport for `RecorderBridge` alone. The host's layout holds the `RecorderProvider`, so a recording outlives the route.                                                                                  |
| Downloads              | `tauri-plugin-native-webview`    | The `on_download` hook must be set when the content webview is built, so the plugin owns it; the sniffer passes `saved_data` on every open.                                                                                                                                                                             |

## Decisions

| Topic        | Decision                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request side | Response-only. Entries carry `method: UNKNOWN`, no request headers or body, and a `comment` saying why. Request-side capture is #440. (The sniffer's `ResponseStart` does carry an observed `method`; using it needs an `emitHarFromLog` change and is a follow-up.)                                                                                  |
| Filter       | Drop `text/css`, `image/*`, `video/*`, `audio/*`, `font/*` by response content type. **JavaScript is kept**, deliberately diverging from #578's `isOmittedContentType`; the recorder owns `isOmittedFromRecording` permanently.                                                                                                                       |
| DOM snapshot | `PageLoaded`'s DOM body arrives as an ordinary Start/Data/Finished triple and is recorded like any other response.                                                                                                                                                                                                                                    |
| Body cap     | 5 MB per body (`MAX_BODY_BYTES`). Over-cap entries stay in the archive as `bodyAbsent` with a comment; the true byte count survives only on `Recording.observedBodyBytes`, because `HttpArchive.Entry` has no size field.                                                                                                                             |
| Naming       | Flat: `Wildflower Recordings/<YYYY-MM-DDTHH-mm-ssZ>-<host>.har`, host reduced to `[a-z0-9.-]`, at most 200 characters. The 200 bound is stated on both sides (TS producer, Rust validator); drift is fail-safe because the host is the stricter one.                                                                                                  |
| Collisions   | The host refuses to overwrite an existing target (`AlreadyExists`) rather than clobbering.                                                                                                                                                                                                                                                            |
| Folder       | `Wildflower Recordings` in the user's Documents on the desktop (else their Downloads), their Downloads on the sandboxed Mac App Store build (else its container's Documents), Android's shared `Documents` (else the app's own in its external storage, where Android won't let it write there), the app's Documents on iOS. Fixed: no folder picker. |
| Instance     | The sniffer's one `sniffer` native-webview instance.                                                                                                                                                                                                                                                                                                  |
| Lifecycle    | Start, Stop & Save, and a window close (`UserDismissed`) all end the recording the same way. `stop()` is idempotent, and unmounting the `RecorderProvider` mid-recording still sends `SniffingComplete` so no window is orphaned; leaving the page doesn't unmount it.                                                                                |
| Downloads    | Desktop only, deliberate user downloads only (attachments and non-renderable navigations). Always enabled for the sniffer instance. Files land flat in `<app data dir>/saved_data/`; nothing in the HAR references them. Mobile backends emit no download events.                                                                                     |

## What the sniffer cannot see

The sniffer shims `fetch` and `XMLHttpRequest`. It never sees `<img>`,
`<link>`, `<script>` or document navigations, and it observes no request
headers or body. The content-type filter above therefore applies to fetch/XHR
responses only; the omitted types mostly matter when a page fetches media
through XHR. A recording is honest about this in its `log.comment` and every
entry's `request.comment`.

## Verification limits

The desktop Tauri crates link `webkit2gtk`, so `recorder-tauri` and the app
crate compile only where it is installed. Everything with logic worth testing
was placed where a plain `cargo test` runs: `recorder-rust` has no `tauri`
dependency, and the plugin's download-name sanitiser is a tauri-free module.
`scripts/checks/rust.sh` lists `recorder-tauri` in its Tauri partition.

## Deliberately not here

- Mobile downloads (`WKDownloadDelegate` / `DownloadListener`).
- Request-side capture (#440) and real request methods in the archive.
- A recordings list, and a choice of folder.
- Show file on iOS and Android, whose file managers can't be asked to select
  a file.
- Anonymization — the Importer's Anonymize tab (#578 A1–A3) consumes the file.

## Where to look next

- `recorder-core-js/src/recording.ts` — the accumulator and its rules.
- `recorder-react/src/use-recorder.ts` — the state machine and ordering.
- `recorder-rust/src/save.rs` — name validation and the atomic write.
- `recorder-rust/src/recordings_folder.rs` — where each platform saves.
- `apps/host/tauri-plugin-native-webview/src/desktop/lifecycle.rs` — the download hook.
