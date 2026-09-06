# AGENTS.md — slices/web-trace/web-trace-react

The browser UI adapter of the web-trace slice: the on-device viewer for recorded
browsing sessions and the device's documents, mounted by the host app. This
package is scheduled for retirement in R2 of #578 — the anonymize flow already
moved to [`har-anonymizer-react`](../../importer/har-anonymizer-react/AGENTS.md)
in A1 of the same epic.

## Layering

`web-trace-react` is an adapter and follows the rule in
[slices/AGENTS.md](../../AGENTS.md): it depends on `web-trace-core`, never the
reverse. It also depends on `fhir-r4` (the typed client) and `fhir-r4-react`
(the authed runner and the slice runtime layer).

**Presentation and interaction only.** The codec belongs to `web-trace-core`
and the HAR emitter and anonymizer to `har-importer-core`; this package
imports them and reimplements none of them. The viewer shows raw captured
values because it runs on the user's own device against the user's own data;
redaction belongs to the export boundary, which lives one slice over.

## Module layout

- **`src/queries/`** — the reads. `trace-exchanges.ts` is the paged
  `DocumentReference` search pinned to the web-trace category and decoded back
  into `TraceExchange`s; `documents.ts` is its category-agnostic sibling, which
  hands back the resources undecoded; `page-token.ts` pulls the continuation
  cursor out of a bundle's `next` link; `keys.ts` holds the query-key roots.
- **`src/sessions/`** — `group-sessions.ts` is the pure grouping of exchanges
  into sessions, `use-trace-sessions.ts` is the hook over the paged read (and
  `summarizePages`, its pure half), `sessions-list.tsx` is the list.
- **`src/exchanges/`** — `filter-exchanges.ts` is the pure URL/status/content-type
  filter, `exchange-key.ts` the cheap per-exchange key the list and the selection
  use, `exchange-filters.tsx` its controls, `exchange-list.tsx` the list, and
  `exchange-detail.tsx` one exchange in full.
- **`src/attachments/`** — `viewable-attachment.ts` is the viewer's view-model,
  its two adapters, and the content-type classification; `attachment-viewer.tsx`
  is the viewer itself, shared by both tabs.
- **`src/documents/`** — the documents tab. `document-filters.ts` is the pure
  filters → search-parameters translation, `describe-document.ts` the pure "what
  did the record actually say" helpers, `document-filters-bar.tsx` the controls,
  `documents-list.tsx` the list, `document-detail.tsx` one document in full, and
  `documents-panel.tsx` composes them; `use-documents.ts` is the hook over the
  paged read.
- **`src/recordings/`** — `recordings-panel.tsx` composes the above into the
  mountable recordings tab. The export flow that used to live in `src/export/`
  moved to `har-anonymizer-react` in A1 of #578 (the anonymizer speaks HAR
  now), so this panel no longer opens one.

## Traps

- **The viewer shows raw values, and that is the design.** Capture is lossless
  and this runs on the user's own device against the user's own data. Nothing in
  this package redacts. Redaction belongs to the export flow, at the boundary
  where data leaves — read the
  [Anonymization Explanation](../../importer/har-importer-core/docs/Anonymization%20Explanation.md)
  before adding anything that touches the pseudonymizer.
- **A session is a grouping, not a resource.** Exchanges carry their session id
  as a shared `identifier`; nothing joins them, and there is no server-side
  aggregate over that axis. So the sessions list is `groupIntoSessions` over
  whatever pages have been read, and **an exchange count is a lower bound until
  paging finishes** — `SessionsList` renders `12+ exchanges` while `hasMore`, and
  `1+` takes the plural noun because it means "at least one".
- **Grouping spans pages, it does not run per page.** One session's exchanges
  routinely straddle a page boundary, so grouping a page at a time would list the
  same session twice. `summarizePages` flattens first, then groups.
- **The search filters by `category`, never by `subject`.** Traces deliberately
  carry no `subject` (see the core's traps), so `category` is the only axis they
  are reachable on. The token is built from `web-trace-core`'s constants —
  `WEB_TRACE_CATEGORY_TOKEN` — rather than spelled out, so it cannot drift from
  what the codec writes.
- **A resource that fails to decode is counted, not raised.** Effect array decode
  is all-or-nothing, so failing the page would let one resource from an older
  encoding make every recording on the device unreadable. `TraceExchangePage.unreadable`
  carries the count and `SessionsList` surfaces it — a partial list must never
  read as a complete one. The count is of **exchanges**, not recordings: one
  trace resource is one exchange, so the notice counts exchanges rather than
  recordings; calling them recordings would claim whole sessions were lost. A
  `DocumentReference` from another category is a different case: not a trace at
  all, so dropped without being counted.
- **A failed read renders nothing, not an empty list.** "No recordings on this
  device" is a claim about the device; a failed read only means the device was
  never successfully asked. `RecordingsPanel` shows the banner alone when the
  read failed and produced nothing.
- **Paging goes through `_pageToken`, read off the bundle's `next` link.** Do not
  follow the link URL directly — that bypasses the typed client's schema and its
  auth. An unparseable or token-less `next` link reads as "no more pages"
  (`nextPageToken` returns `undefined`) rather than failing the read — and a
  present-but-empty `_pageToken=` counts as token-less, since `''` is not `null`
  and TanStack Query would take it for a real cursor and re-request page one
  forever.
- **`status: 0` is a real value.** The sniffer reports it for an opaque CORS
  response or an aborted request, so it classifies as `other`, badges as a
  warning, and renders as `opaque` — never as a zero-valued success.
- **A skipped body renders as skipped.** `describeBody` prints its size and
  reason in the list, and `AttachmentViewer` prints its size, hash, and reason in
  the detail. Flattening a `SkippedBody` into "no body" would make the viewer
  claim something the trace does not.
- **One attachment viewer, two adapters — not two viewers.** Neither `TraceBody`
  nor FHIR `Attachment` can be the viewer's input on its own: `SkippedBody.reason`
  has no slot in `Attachment`, and `Attachment.url` has no counterpart in
  `TraceBody`. `ViewableAttachment` is the shared shape, and `fromTraceBody` /
  `fromFhirAttachment` adapt into it. Add a third caller by writing a third
  adapter, never by branching inside the viewer.
- **`AttachmentAbsence` has three cases and they are not interchangeable.**
  Skipped at capture, held elsewhere by URL, and genuinely empty are different
  facts; collapsing them to "no content" makes the viewer assert something the
  record does not.
- **An SVG is never rendered as an image.** `NEVER_RENDERED_MEDIA_TYPES` is
  checked before every other rule in `previewKindFor`, so no later reordering can
  promote one to `image`. An SVG can carry script and remote references, and
  rendering a captured one would run what the recorded page served against the
  viewer's own origin. Its markup renders as text instead.
- **An unrecognised content type gets no preview.** The capture stores bodies of
  any type; rendering arbitrary bytes as text produces noise that reads like
  data. The viewer shows the metadata and says there is no preview.
- **Images render from a `data:` URI, never a fetch.** No network egress at any
  point is the premise of the app, and a by-reference attachment is named rather
  than retrieved for the same reason.
- **A large body waits behind a control.** The verbatim capture policy stores
  bodies whole, so pretty-printing one into the DOM on open can hang the tab.
  Past `PREVIEW_CHARACTER_CAP` the viewer offers to show it; the content stays
  reachable, just not by accident. The reveal state holds _the bytes it was
  granted for_, not a boolean — the viewer is shared, so a caller can hand the
  same mounted instance a different attachment, and a leftover `true` would open
  the next large body immediately. For the same reason the decode is memoized on
  those bytes: the cap can only be checked against the decoded length, so the
  decode runs before the guard and must not run again on every render.
- **One content-type normalisation, two names.** `mediaTypeOf` is the function;
  `filter-exchanges.ts` re-exports it as `normalizeContentType` because that is
  what the filter calls its key. A second copy could drift, and a body that
  classified one way for the filter and another for the viewer would be a bug
  with no visible cause.
- **Skin values come from the tundraish token ramps.** `--space-N`, `--radius-N`,
  `--color-divider`, `--color-neutral-N`, and `--font-mono` for genuine machine
  strings (a captured URL, a header row, a body, a hash). A literal `rem` or a
  `color-mix` off `currentColor` renders fine but drops out of the design system
  the moment a token is re-pointed — see `react-tundraish/src/tokens.css`.
- **Rows are keyed by `exchangeKey`, never by `traceResourceId`.** The resource
  id is two 64-bit hash lanes over the `(sessionId, requestId)` pair — right at a
  write or a decode, wrong in a render body. Both the list's `ItemListItem.id` and
  `RecordingsPanel`'s `openExchangeId` run per listed exchange on every render,
  and this panel owns the filter state, so one keystroke re-runs both: measured at
  ~24 ms per keystroke over a thousand exchanges, against ~0.04 ms for the pair.
  Neither needs the resource id — a React `key` and a selection key want identity
  within one rendered list, which the pair already is.
- **The filter components are fully controlled.** `ExchangeList` and
  `ExchangeFiltersBar` hold no filter state; the owner does (`RecordingsPanel` in
  production, a small wrapper in the tests). Content-type options are computed
  from the _unfiltered_ exchanges, or choosing one would collapse the select to
  that single choice and make it unrecoverable.
- **`ItemList` rows here are buttons, not links.** They take `onClick`, so no
  router is needed to render one — which is what lets the list components be
  tested without mounting a router.

### Documents tab

- **The documents read is a sibling of the trace read, never a parameter on
  it.** `trace-exchanges.ts` pins `category` and decodes every row through
  `fromDocumentReference`; `documents.ts` sends no category and does not decode.
  One read that sometimes decoded and sometimes did not would have no single
  return type, and the two carry different page shapes for the same reason.
- **A neutral filter control sends no parameter at all.** FHIR reads `category=`
  as a search for the empty token, which matches nothing — so an untouched box
  would silently produce "no documents" rather than every document.
  `documentSearchParams` is the one place that is decided, and a property test
  pins that no axis can ever emit an empty value.
- **The filters are part of the query key.** They narrow server-side, so
  changing one is a different search rather than a narrowing of loaded rows.
  Sharing a key would serve the previous search's rows under the new filters
  until a refetch landed.
- **This read has no `unreadable` count, and that is not an oversight.** The
  trace read gets a second, per-resource decode it can fail leniently; here the
  typed client decodes the whole bundle, and Effect array decode is
  all-or-nothing — one `DocumentReference` the schema rejects fails the page.
  That is the client's contract. An entry with no `resource` is still dropped
  silently, since it is an `outcome` rather than a lost document.
- **`Coding.system` and `Identifier.system` decode to `URL`, which adds a
  trailing slash to a host-only URI.** The server's `http://loinc.org` reads
  back as `http://loinc.org/`, and these strings render as `system|code` tokens
  a reader copies into the filter box — where the extra slash matches nothing.
  `systemUri` drops the lone root slash and only that one; a URI with a path
  keeps whatever it carries, because the decode cannot tell an added slash from
  a real one there.
- **A concept that says nothing describes as nothing.** A `CodeableConcept` with
  neither `text` nor `coding` yields `null`, never a placeholder — a placeholder
  reads as a value the server sent.

### Export flow

Moved to [`har-anonymizer-react`](../../importer/har-anonymizer-react/AGENTS.md)
in A1 of #578. The panel now takes a parsed `HttpArchive.Log` (not a session
of trace documents) and drives `har-importer-core`'s HAR-native anonymizer
directly. The traps that used to live here — preview as the pseudonymizer's
own output, salt minted once and threaded, both carve-outs off on open,
JSON-only and says how much it drops, encode before stringify — carry over
to that package's AGENTS.md verbatim.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
and [React Testing Reference](../../../docs/Testing/React%20Testing%20Reference.md).

- The exchange arbitraries come from `web-trace-core/test-helpers`, reshaped
  locally into multi-session corpora. `Arbitrary.make(TraceExchange)` would
  generate URLs that are not URLs and bodies that are not base64.
- `queries/trace-exchanges.test.ts` drives the query over the real
  runner → FHIR-client → `HttpClient` path with a stub `HttpClient`, mirroring
  `fhir-r4-react`'s `queries/patients.test.ts`. It asserts the search actually
  filters by `category` — a query that read the whole table would still pass
  every other assertion.
- `recordings/recordings-panel.test.tsx` is the end-to-end one: it replaces only
  the router seam (`useRunAuthed`) and drives the whole tab, including the
  straddling-session merge across two pages and the walk down to an exchange
  detail.
- Assertions about re-indented JSON pass an identity `normalizer`. Testing
  Library collapses whitespace by default, which would erase the indentation
  those assertions exist to check.
- The FHIR `Attachment` fixtures decode wire JSON through `Attachment.Schema`
  rather than hand-writing the decoded shape, so they carry the schema's brands
  and its absent-field handling instead of a test author's guess at them. The
  document fixtures in `documents/describe-document.test.ts` decode through
  `DocumentReference.Schema` for the same reason — and `content` is required
  `1..*` with no default, so a fixture that says nothing about content still has
  to carry one.
- `documents/documents-panel.test.tsx` is what makes "one attachment viewer,
  two adapters" an observed fact rather than a claim about the shape of the
  code: it walks down to a document's content and finds the shared viewer's own
  output, including the by-reference case a `TraceBody` cannot express.
- The export-flow tests moved to `har-anonymizer-react` in A1 of #578, along
  with the flow itself. The traps they encode — decoding the archive's bodies
  before asserting, defining `URL.createObjectURL` **onto** the real `URL`,
  the single-patient corpus asserted against the **downloaded archive** — all
  live in that package's tests now.

## References

- [slice AGENTS.md](../AGENTS.md) — why this slice exists, and the store-raw /
  view-raw / anonymize-at-export asymmetry this package is the "view raw" half of.
- [web-trace-core AGENTS.md](../web-trace-core/AGENTS.md) — the vocabulary, the
  codec, and the traps behind them.
- [slices/AGENTS.md](../../AGENTS.md) — the layering rules.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
