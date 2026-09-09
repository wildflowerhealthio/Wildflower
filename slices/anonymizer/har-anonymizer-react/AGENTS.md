# AGENTS.md — slices/anonymizer/har-anonymizer-react

The **HAR panel** of the anonymizer slice: the panel a host mounts over a
parsed `HttpArchive.Log` to review the pseudonymizer's decisions and download
an anonymized `.har`. Presentation and interaction only — the redactor and the
leaves traversal live in [`har-anonymizer-core`](../har-anonymizer-core/AGENTS.md),
the HAR emitter in
[`har-importer-core`](../../importer/har-importer-core/AGENTS.md); nothing here
reimplements any of them.

## Shape

- `src/anonymize-panel.tsx` — **`AnonymizePanel`**, the surface. Input is
  `{ log: HttpArchive.Log, fileName: string }`. Drives `useAnonymize`, renders
  the manifest, the settings, the two-section preview (verbatim vs.
  pseudonymized), and the download button.
- `src/use-anonymize.ts` — the hook. Mints a per-anonymize salt once and
  threads it through every rebuild; keeps the preview in step with the settings
  and per-path overrides.
- `src/redaction-preview.ts` — builds one section's rows **from the
  pseudonymizer's own output** (`redactLog`), so the `after` a reviewer reads
  is what the archive carries. Also `droppedBodyCount` / `jsonBodyCount`
  over the raw log, so the manifest states what will and will not be dropped.
- `src/download-har.ts` — turns an emitted archive into a same-origin blob and
  saves it under `<original-stem>.anonymized.har` (`anonymizedFileName`).

## Layering

An adapter. Depends on `har-anonymizer-core` (the redactor),
`har-importer-core` (`/har` — the projection and emitter), `effect`, `react`,
`react-kitchen-sink`, `react-tundraish`. Never imports `web-trace-core`
(the redactor and emitter are HAR-native here — this package does not speak
`TraceExchange`), `web-trace-react`, `importer-react`, or `slices/collector`.

## Traps

The traps carry over verbatim from the export flow this panel used to be in
`web-trace-react`; every one still holds against `HttpArchive.Log` because the
core's decision rules are unchanged.

- **The preview is the pseudonymizer's output, not a second implementation.**
  `buildAnonymizePreview` runs `redactLog` and samples the `after` values from
  what it produced, and the panel emits **that same log**. A preview that
  computed its own before/after would defeat the acceptance test it exists to
  satisfy — and could show a reviewer something the download does not do.
- **The salt is minted once per anonymize and threaded.** Changing the
  threshold or an override re-runs redaction under the _same_ salt. Minting
  per rebuild would re-pseudonymize everything on each keystroke, and would
  break the property the design rests on: pseudonyms stable _within_ an
  anonymize so identifier joins survive, independent _across_ anonymizes so
  two archives cannot be linked.
- **The panel runs `exchangesFromArchive`… no, it doesn't.** The redactor is
  HAR-native: `AnonymizePanel` hands `log` straight to `useAnonymize`, which
  hands it to `buildPolicyForLog` and `redactLog`. There is no
  `TraceExchange` intermediate to construct.
- **The log is the memoised identity that triggers a rebuild.** The parent
  parses the `.har` once and hands the panel a stable `HttpArchive.Log`. If a
  parent rebuilt the log on every render, the preview would rebuild too.
- **A failed rebuild clears the preview.** Leaving the previous one downloadable
  would hand over an archive built under settings the reviewer has since
  changed.
- **Both carve-outs are off when the panel opens.** The safest archive is the
  one produced by clicking Download without reading anything, so exporting
  original values is opted _into_ against a preview that lists exactly what it
  exposes, not opted out of afterwards. That applies to schema URLs as much as
  to short codes, even though a namespace URI is the safer of the two to
  expose. The core's own default (both on, N=12) is the default for the
  _threshold_ once codes are switched on — see `DEFAULT_ANONYMIZE_SETTINGS`,
  which deliberately disagrees with the core on the two booleans: the core
  answers "what should redaction do when nobody said", the panel answers
  "what should leave the device when nobody looked".
- **There are two switches, so `getByRole('switch')` is ambiguous.** Query by
  accessible name (`codesSwitch` / `schemaUrlsSwitch` in the tests). Both
  settings are also part of the rebuild effect's dependency list and of
  `describeSettings`, so the archive's own `log.comment` states each one — an
  archive that did not say which rules were on could not be read back years
  later.
- **A schema-URL row names its rule, not its count.** `Auto — visible (schema
URL)` / `Auto — hidden (schema URLs off)`. Those paths are exempt from the
  threshold, so reporting `visible (18 values)` would send the reviewer to a
  control that had no say in the decision.
- **The preview is split by outcome, not listed as one table.** The rows that
  need scrutiny are the ones leaving **as captured**; they are a handful next
  to the pseudonymized majority, which sits behind a disclosure so it cannot
  bury them. A single sorted table put the rows that matter wherever the path
  names happened to fall.
- **The `Auto` option says what it resolves to, and why.** `Auto — visible
(3 values)` / `Auto — hidden (not a code)` / `Auto — hidden (codes off)`. A
  bare `Auto` makes the reviewer infer the outcome from another column, and
  the two hidden cases have different fixes — one is answered by raising the
  threshold, the other never is.
- **The preview table is fixed-layout with explicit column widths.** A path
  key is several times longer than the values beside it, so an auto-laid-out
  table hands the path most of the width and squeezes the captured/exported
  columns — the ones actually being read — down to a few characters.
- **The anonymize is JSON-only, and says how much it drops.** A non-JSON body
  becomes an absent one at the redaction boundary — the redactor cannot
  pseudonymize a format it cannot parse, and shipping one unredacted is not an
  option. `droppedBodyCount` surfaces the difference. An anonymize that
  quietly dropped a body would misrepresent what the source held.
- **The manifest states that request method, headers and body were dropped.**
  True for a DevTools/extension export where they existed: the projection
  `HttpArchive.Log` carries the response half only, and the archive's
  `log.comment` says the same via `describeSettings`.
- **The archive is encoded before it is stringified.** `emitHarFromLog` builds
  the _decoded_ form of the `Har` schema — instants are `DateTime`s, bodies
  are a tagged union — so `harBlob` runs `Schema.encodeSync(Har)` first. A
  plain `JSON.stringify` of what `emitHarFromLog` returns writes a file no HAR
  reader accepts.
- **The download is a blob from the app's own origin, and there is nowhere to
  add an upload.** No network egress at any point is the premise of the app.
- **A preview row can honestly show `before === after` for a path it calls
  pseudonymized.** `null`, `true`/`false`, and `''` are structure rather than
  data, so `redactEntry` passes them through whatever the policy decided. The
  row's decision is about the **path**; its before/after is a **sample**, and
  a sampled structural value survives. Do not "fix" this by rewriting the
  decision per value — the row would then disagree with the policy the archive
  was actually built from.
- **A source file name is not assumed to be path-safe.** It comes from the
  file picker, so `anonymizedFileName` strips the trailing `.har` and
  sanitises the stem; a stem that sanitises to nothing falls back to
  `archive`, since a file named `.anonymized.har` is hidden on Unix and
  reads as a failed download.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document.

- `anonymize-panel.test.tsx` — the acceptance tests, ported from
  `web-trace-react`'s `export-panel.test.tsx` with the input re-typed. The
  single-patient case, the twenty-MRN case, the FHIR bundle case, all
  asserted against the **downloaded archive** with its bodies base64-decoded
  first (HAR carries a body as base64 in `content.text`, so searching the raw
  file finds nothing whether or not it was redacted). Also a
  DevTools-shaped archive with request method, request headers and a request
  body, decoded through `HttpArchive.LogFromHarJson` and passed through the
  panel, asserting the downloaded archive has no request side (method
  `UNKNOWN`, no headers) and none of the request-side or response-side
  captured leaf values survive.
- `redaction-preview.test.ts` — the same "the preview is the pseudonymizer's
  own output" properties, over `HttpArchive.Log` inputs.
- `download-har.test.ts` — `anonymizedFileName` sanitisation and the
  `<stem>.anonymized.har` shape; `harBlob` round-trip through the real
  `HarFromJson` schema. Defines `URL.createObjectURL` **onto** the real `URL`
  never over it, so the pseudonymizer's `new URL(...)` still works.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [har-anonymizer-core AGENTS.md](../har-anonymizer-core/AGENTS.md) — the
  redactor this panel drives.
- [har-importer-core AGENTS.md](../../importer/har-importer-core/AGENTS.md) —
  the HAR projection and emitter.
- [Anonymization Explanation](../docs/Anonymization%20Explanation.md)
  — the pseudonymizer's design and its stated limits.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
