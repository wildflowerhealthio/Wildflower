# AGENTS.md — slices/har-recorder/har-recorder-core

The **HAR Recorder's pure layer**: sniffer response events in, a HAR 1.2 archive
out, plus the bridge that carries the finished file text to the host that writes
it. No DOM, no `fs`, no React, no Effect runtime.

## Shape

- `src/recording.ts` — **`Recording`**, the accumulator. `ResponseStart` /
  `ResponseData` / `ResponseFinished` / `RequestError` / `Cancelled` in,
  `HttpArchive.Entry[]` out in settle order. Mutable by design (a session is
  megabytes of body chunks), and clock-free: every instant it records is one the
  caller observed and passed in. `MAX_BODY_BYTES` (5 MB) lives here.
- `src/omitted.ts` — **`isOmittedFromRecording`**: `text/css` and any
  `image/*` / `video/*` / `audio/*` / `font/*`. **JavaScript is kept**, which is
  a permanent, deliberate divergence from `http-extraction-fundamentals`'
  `isOmittedContentType` — do not collapse the two.
- `src/file-name.ts` — **`recordingFileName`**: `<YYYY-MM-DDTHH-mm-ssZ>-<host>.har`,
  one path segment a Windows filesystem accepts, ≤ 200 characters.
- `src/to-har.ts` — **`toHar`**: the recording through `http-archive`'s
  `emitHarFromLog`, naming the recorder and stating what the recording did not
  carry. Encoding it to file text is `http-archive`'s `harToJson`.
- `src/bridge.ts` — **`HarRecorderBridge`**: `SaveHar` (web→host), `HarSaved` /
  `HarSaveFailed` (host→web). The TSDoc holds the exact wire strings
  `har-recorder-rust` is pinned to.
- `src/index.ts` — re-exports all five.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect`,
`browser-sniffer-core` (the message types it consumes), `http-archive`
(`HttpArchive.Entry` / `Log`, `emitHarFromLog`, `ENTRY_ID_PREFIX`),
`effect-messaging-core` (`Bridge`), and — transitionally, until #578 dissolves
`slices/web-trace` — `web-trace-core` (`contentTypeOf`). Never imports a React
package, `collector-*`, or anything from `slices/importer`.

The sniffer events the recording is built from arrive on **`CollectorBridge`**,
not on `HarRecorderBridge` — this package only names their decoded types.

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
- `bridge.test.ts` — the documented wire strings decode, and each side declares
  the tags it owns.

## References

- [slices/har-recorder AGENTS.md](../AGENTS.md) — the slice's role and packages.
- [http-archive AGENTS.md](../../file-formats/http-archive/AGENTS.md) — the HAR
  format and the `emitHarFromLog` options this package passes.
- [browser-sniffer AGENTS.md](../../browser-sniffer/AGENTS.md) — where the
  recorded events come from.
- [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md) —
  the discipline `src/bridge.ts` follows.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
