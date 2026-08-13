# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice: the source picker that turns any of
three inputs — a file dropped on the zone, a file chosen through the OS picker, or
a HAR archive already uploaded to the device's own FHIR server — into one
`PickedHar` the rest of the importer replays. Plus the upload that puts a local
HAR onto the device as an archive `DocumentReference`.

## Layering

`importer-react` is an adapter and follows the rule in
[slices/AGENTS.md](../../AGENTS.md): it depends on its sources, never the reverse.
It depends on `web-trace-core` (the HAR archive codec under `/codec` and the HAR
parser under `/har`), `fhir-r4` (the typed client), and `fhir-r4-react` (the
authed runner and the slice runtime layer).

**It does not depend on `importer-core`.** This package was built parallel with
the core, so the picker's job ends at a `PickedHar` — the seam the rest of the
importer consumes — and nothing here imports the core. If a later change wants to
hand the core more than a `PickedHar`, widen that type; do not reach into the
core from a component.

**Presentation and interaction only.** Nothing here parses HAR or encodes an
archive. The parser (`fromHarJson`) and the archive codec
(`harArchiveToDocumentReference` / `harArchiveFromDocumentReference`) are
`web-trace-core`'s; this package drives them and reimplements neither.

## Module layout

- **`src/sources/`** — the picker. `picked-har.ts` is the vocabulary
  (`PickedHar`, and the `local` / `server` `PickedHarSource`); `local-har.ts` is
  the pure "read a local file and validate it as a HAR" gate; `source-picker.tsx`
  is the surface that composes the drop-and-pick zone, the file input it opens,
  and the server archive list.
- **`src/queries/`** — the reads. `har-archives.ts` is the paged
  `DocumentReference` search pinned to the HAR-archive category, plus
  `fetchHarArchive` — the one-archive fetch-and-decode a row selection runs;
  `page-token.ts` pulls the continuation cursor out of a bundle's `next` link
  (a copy of the web-trace viewer's, see the trap); `keys.ts` holds the query-key
  roots.
- **`src/mutations/`** — the write. `upload-har.ts` mints a fresh archive from a
  local file's bytes and PUTs it, then invalidates the archive list.

## Traps

- **A HAR archive and a web trace share a code system and nothing else, and the
  disjointness is load-bearing.** The archive list searches `category` for
  `` `${WEB_TRACE_CODE_SYSTEM}|har-archive` `` (`HAR_ARCHIVE_CATEGORY_TOKEN`,
  built from `web-trace-core`'s constants so it cannot drift from what the codec
  writes), and `rowsOf` still guards each entry with `isHarArchive`. The
  web-trace viewer lists traces; this lists archives; `isWebTrace` and
  `isHarArchive` never both hold. The list must never surface a trace.
- **The picker validates a local file through the real HAR parser, not a second
  check.** `acceptLocalHar` runs `web-trace-core`'s `fromHarJson`, so a file the
  picker accepts is a file a replay can parse, and a file that is not JSON and a
  file that is JSON-but-not-HAR both fail _at the picker_, next to the control the
  user just used, rather than three steps downstream. The parse result is
  discarded — this is a gate, and the replay parses the text again when it runs.
- **`page-token.ts` is a copy of `web-trace-react`'s, deliberately.** The two
  slices page the same FHIR server the same way, but the importer must not depend
  on the web-trace viewer to do it — an adapter reaching into another adapter is
  the wrong layer. A shared paging primitive would belong below both, not in one.
  A present-but-empty `_pageToken=` reads as token-less: `''` is not `null`, so
  TanStack Query would take it for a real cursor and re-request page one forever.
- **The list carries rows, not archives.** An archive's bytes are the whole HAR
  file, potentially megabytes; `HarArchiveRow` holds only the id, title, and
  upload instant, and `fetchHarArchive` reads the one archive the user selects.
  Listing the bytes to render a title would pull every archive onto the device to
  draw a list.
- **A row selection decodes through the archive codec, then `TextDecoder`s the
  bytes.** `fetchHarArchive` runs `harArchiveFromDocumentReference` (a resource
  that is not an archive fails as a `ParseError`, never yields nonsense), then
  `new TextDecoder().decode(archive.bytes)` — a HAR is UTF-8 JSON. The `server`
  source carries `DocumentReference/<id>` so a later step links provenance to the
  stored archive rather than re-uploading the same bytes.
- **Every upload is a fresh document.** `useUploadHar` mints a uuid with
  `crypto.randomUUID()` per call and uses it as both the resource id and the
  `Update` path, so the PUT preserves the client-minted id and two uploads of the
  same bytes are two documents — never one silently overwriting the other. That
  is the archive codec's contract; dedupe stays _detectable_ through the
  attachment's `hash` and `size` without being forced.
- **Upload takes bytes, not text.** The archive codec stores the file verbatim so
  a truncated or mis-encoded upload is preserved and the attachment `hash` means
  something. `UploadHarInput.bytes` is `Uint8Array`; a caller holding a
  `PickedHar`'s text encodes it (`new TextEncoder().encode(text)`) at the call
  site.
- **The drop zone is a button, so drop is an enhancement rather than the only
  path.** The zone itself opens the file picker on click, so the whole surface is
  keyboard-reachable and screen-reader named; the `<input type="file">` it opens
  is visually hidden but kept a named, reachable input (`aria-label="HAR file"`),
  not `display: none` — some upload implementations refuse an invisible input.
- **The authed runner comes from router context, one way.** `useHarArchivesQuery`
  and the picker's row-select both read `useRunAuthed()`; the query also exposes
  `harArchivesInfiniteQueryOptions(runAuthed, options)` taking the runner as its
  first argument, for a loader or a test that drives the query itself. There is no
  prop-threaded second way in — this mirrors `web-trace-react`.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
and [React Testing Reference](../../../docs/Testing/React%20Testing%20Reference.md).
Use the workspace-local `node_modules/.bin/vp` for jsdom runs.

- `sources/source-picker.test.tsx` mocks only the router seam
  (`vi.mock('fhir-r4-react', … useRunAuthed …)`, the `documents-panel.test.tsx`
  pattern) and drives the whole picker over a stub `HttpClient`. The runner is
  built through `fhir-r4-react/smart`'s `buildSmartRouterContext` so a bearer
  token rides the wire and the test can assert `Authorization: Bearer …` and the
  search URL (`category` token, `_count`, `_pageToken`) against the recorded
  requests — the `app.test.tsx` shape.
- The three-paths test synthesizes a `DataTransfer` for the drop, uploads to the
  hidden input for the pick, and clicks a row for the server source. The two
  local paths yield an identical `PickedHar` (`local` source); the server path
  yields the same text under a `server` source. The server archive fixtures are
  hand-built `DocumentReference` JSON with base64 `data` — not encoded through the
  codec — so a `Uint8Array` from jsdom's realm never has to satisfy the codec's
  `instanceof` check (`new TextEncoder().encode(…)` there produces a foreign-realm
  array the archive schema rejects).
- `mutations/upload-har.test.tsx` renders the hook over a _stateful_ stub that
  stores each PUT under its minted id and answers a later search with it, so the
  list — mounted alongside — refetches on invalidation and the new archive appears
  as an observed fact rather than a spy. It also asserts two uploads of the same
  bytes produce two distinct ids.

## References

- [slices AGENTS.md](../../AGENTS.md) — the slice layering rules this package
  follows. The `slices/importer/AGENTS.md` slice-family doc is owned by the
  importer-core ticket and is intentionally not linked here until it lands.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the HAR
  archive codec and the HAR parser this package drives, and the disjointness of
  traces and archives.
- [web-trace-react AGENTS.md](../../web-trace/web-trace-react/AGENTS.md) — the
  paged-read and router-seam patterns this package clones.
- [emr AGENTS.md](../../emr/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
