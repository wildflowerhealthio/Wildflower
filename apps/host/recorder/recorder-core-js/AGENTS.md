# AGENTS.md — apps/host/recorder/recorder-core-js

The **Recorder's pure layer**: sniffer response events in, a HAR 1.2 archive
out, plus the bridge that carries the sniffer's traffic in and the finished
file text out to the host that writes it. No DOM, no `fs`, no React, no Effect
runtime.

## Shape

- `src/recording.ts` — **`Recording`**, the accumulator. `ResponseStart` /
  `ResponseData` / `ResponseFinished` / `RequestError` / `Cancelled` in,
  `HttpArchive.Entry[]` out in settle order. Mutable by design (a session is
  megabytes of body chunks), and clock-free: every instant it records is one the
  caller observed and passed in. `MAX_BODY_BYTES` (5 MB) lives here.
- `src/omitted.ts` — **`isOmittedFromRecording`**: `text/css`, every standard
  and legacy JavaScript MIME type, and any `image/*` / `video/*` / `audio/*` /
  `font/*`. Aligns with `http-extraction-fundamentals`' `isOmittedContentType`
  on which types to drop — but the two predicates stay separate; do not collapse
  them.
- `src/file-name.ts` — **`recordingFileName`**: `<YYYY-MM-DDTHH-mm-ssZ>-<host>.har`,
  one path segment a Windows filesystem accepts, ≤ 200 characters.
- `src/to-har.ts` — **`toHar`**: the recording through `http-archive`'s
  `emitHarFromLog`, naming the recorder and stating what the recording did not
  carry. Encoding it to file text is `http-archive`'s `harToJson`.
- `src/bridge.ts` — **`RecorderBridge`**, the recorder's one bridge. Host→Web:
  `browser-sniffer-core`'s data-plane messages (`ResponseStart`,
  `ResponseData`, `ResponseFinished`, `RequestError`, `Cancelled`,
  `PageLoaded`, `PageRequested`), the sniffer window's `UserDismissed` and
  `SnifferDisposed`, and `HarSaved` / `HarSaveFailed`. Web→Host: `Open` (an
  `http(s)` `Uri` source only, `HttpUrl`), `SniffingComplete` and `SaveHar`.
  Every tag and shape is the one `browser-sniffer-tauri` already routes and
  emits. The TSDoc holds each wire string.
- `src/save-folder.ts` — **`readSaveFolder`**: the host's
  `recorder_save_folder` command over an injected `invoke`, its answer
  decoded as a `SaveFolder` (`path`, `revealsFiles`), or a
  `SaveFolderUnreadable` with the host's reason.
- `src/index.ts` — re-exports all six.
- `../recorder-wire-golden.json` — one wire payload per `RecorderBridge` tag
  and the `recorder_save_folder` answer, read by `bridge.test.ts`,
  `save-folder.test.ts` and `recorder-rust`'s tests.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect`,
`browser-sniffer-core` (the data-plane schemas), `http-archive`
(`HttpArchive.Entry` / `Log`, `emitHarFromLog`, `ENTRY_ID_PREFIX`),
`effect-messaging-core` (`Bridge`), and — transitionally, until #578 dissolves it
— `web-trace-core` (`contentTypeOf`). Never imports a React
package, `collector-*`, or anything from `slices/importer`.

## Traps

- **`HttpArchive.Entry` carries no body size.** An over-cap body settles as
  `bodyAbsent` with empty bytes, and the projection re-encodes it with
  `content.size` of `0`. The true count survives only on
  `Recording.observedBodyBytes`; the HAR itself states the cap in `log.comment`.
- **Entry ids come from `HttpArchive.ENTRY_ID_PREFIX`**, never a local copy of
  `'har-entry-'` — an id means the same thing whether an archive was read or
  recorded.
- **A partial body is never archived.** `RequestError` / `Cancelled` drop the
  in-flight record, and a chunk whose base64 will not decode settles the entry
  as `bodyAbsent` rather than with a hole in it.

## Testing

- `recording.test.ts` — property tests over arbitrary interleavings of several
  concurrent exchanges, compared against an independently-written oracle;
  example tests for the cap boundary, undecodable base64, and repeated
  terminals.
- `omitted.test.ts` — the example table that states the rule, plus properties
  over the omitted top-level types and the kept JavaScript spellings.
- `file-name.test.ts` — the name is always one safe segment, for any URL.
- `to-har.test.ts` — an emitted archive encodes and reads back through
  `HarFromJson` and `HttpArchive.LogFromHarJson`, bodies byte-identical.
- `bridge.test.ts` — against `recorder-wire-golden.json`: the bridge declares
  exactly the golden tags on the golden side, every host→web payload decodes
  to itself, the data plane decodes as `BrowserSnifferBridge` decodes it,
  every web→host message encodes to its golden shape, and `Open` refuses a
  non-`http(s)` URL; plus the save channel's JSON-string wire.
- `save-folder.test.ts` — the golden answer decodes, a refusal carries the
  host's reason, and an empty path is refused.

## References

- [recorder AGENTS.md](../AGENTS.md) — the recorder's role and packages.
- [http-archive AGENTS.md](../../../../slices/file-formats/http-archive/AGENTS.md) — the HAR
  format and the `emitHarFromLog` options this package passes.
- [browser-sniffer AGENTS.md](../../../../slices/browser-sniffer/AGENTS.md) — where the
  recorded events come from.
- [Wire Pinning How-To](../../../../docs/Messaging/Wire%20Pinning%20How-To.md) —
  the discipline `src/bridge.ts` follows.
- [Doc Comments Reference](../../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
