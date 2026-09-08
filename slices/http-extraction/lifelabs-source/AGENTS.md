# AGENTS.md — slices/http-extraction/lifelabs-source

The **LifeLabs source**: the single definition of how the LifeLabs
MyCareCompass portal's bespoke JSON decodes into FHIR R4 resources, exported
as one `SourceDescriptor` value — `lifeLabsSource`, whose pre-adopted
`responseKinds` an archive import extracts with. A live `lifelabs-collector`
scraping plan (browser-driven, in `slices/collector`) consumes the same
response-kind tuple by reference, so the two consumers can never disagree on a
decode. Like `shoppers-drugmart-source`, this source **synthesizes** R4
resources directly from non-FHIR portal JSON — there is no FHIR dialect layer.

## Shape

- `src/response-kinds/analytic-summary-response-kind.ts` —
  `on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary` → the
  selected `Patient` plus one `Observation` per `entity.analytics[]` row.
- `src/lifelabs.ts` — the identifier/coding-system URL catalogue
  (`LifeLabsIdentifierSystem.PatientId`, `LIFELABS_TEST_SYSTEM`, `LOINC_SYSTEM`).
- `src/source-system.ts` — `LIFELABS_SYSTEM`, the Wildflower-minted `sid` URI
  the kind's `tryRecognize` mints and adoption keys under.
- `src/response-kinds.ts` — `lifeLabsResponseKinds` (internal, the
  descriptor's `responseKinds`): the kind widened to
  `HttpResponseKind<FhirResource>` and mapped through
  `adoptUnderRecognizedRoot`. A module-level constant, stable by identity.
- `src/source.ts` — `lifeLabsSource`, the package's primary export: the
  `SourceDescriptor` (`name: 'lifelabs'`, display strings, and the pre-adopted
  `responseKinds`).
- `src/fixtures/analytic-summary.json` — a **synthesized** payload (see
  [Fixtures & open questions](#fixtures--open-questions)).

## Mapping `analytics[]` → `Observation`

- `status` = `final` (posted results).
- `code.text` = `testItemName` (the analyte, e.g. "WBC"), with two codings:
  **LOINC first** when `testItemId` carries one — the id is base64 of
  `<testCode>__<loinc>;` (`TR10477-8W__6690-2;` is WBC), so
  `{ system: LOINC_SYSTEM, code: '6690-2', display: testItemName }` — then
  LifeLabs' own panel code
  `{ system: LIFELABS_TEST_SYSTEM, code: testCode, display: testName }`. An
  item id of any other shape yields the LifeLabs coding alone.
- `subject` = `Patient/{selectedPatient}` (rewritten onto the derived local id
  by adoption).
- `effectiveDateTime` = `collectionDate` parsed to the absolute UTC instant:
  either a .NET `/Date(ms±hhmm)/` token (the trailing offset is display-only)
  or an ISO 8601 string (offset-less read as UTC) — the portal's sibling report
  endpoints serialize dates as ISO, so the analytic payload is not assumed to
  differ.
- value: a numeric `testResultValue` → a **unitless** `valueQuantity` (the
  source carries no unit — accepted as rare and reasonable), anything else →
  `valueString`.
- `referenceRange` = the raw string as `text`, plus parsed `low`/`high` when it
  is a simple numeric interval (`4.0 - 11.0`, `120- 160`), or the one bound of
  a one-sided `<2.6` / `>=40`.
- `interpretation` = `abnormalFlag` when present.
- logical id = sanitized `testItemId` (base64 → FHIR-safe token: `+`→`-`,
  `/`→`.`, padding stripped) suffixed with the collection millis, so repeat
  draws of the same analyte across dates don't collide. When a capture omits
  `testItemId` the fallback key is `testCode` **plus the analyte name** —
  `testCode` is a _panel_ code (WBC and Hemoglobin share one CBC code and one
  collection instant), so it alone does not identify a row. Analytics with no
  `testItemId` / `testCode` to key are dropped-and-counted.

Only the **selected** patient is synthesized (id = `entity.selectedPatient`,
name from the `patients[]` row whose `value` **is** that id — not from the
primary row, which on a shared account names the account holder rather than the
dependent whose results these are — the id as `identifier[0]`, and one further
identifier per other id in that row's `patientMap`, which lists every portal
patient id that is the same human, such as an earlier registration under
another name). The other
`patients[]` rows name people whose results this response does not carry, and
nothing links to them, so they are not emitted.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `recognizePortal`,
`extractJson`), `fhir-r4` (resources + `identity`'s `adoptUnderRecognizedRoot`),
`effect`, and `kitchen-sink` — nothing else. It must **never** import anything
from `slices/collector` (the live config/plan/form are the collector's concern)
or `slices/importer` (whose `har-importer-core` consumes
`lifeLabsSource.responseKinds`).

## Traps

- **The recognizer is an exact, anchored full-URL regex**, pinned to the
  Ontario API host (`on-api.mycarecompass.lifelabs.com`) and the whole
  `/api/Report/GetAnalyticSummary` path — only the query varies. Other
  provinces (`bc-api.` …) are a deliberate follow-up, not a loosening of this
  pattern.
- **`LIFELABS_SYSTEM` is persisted wire format.** It is the hash domain for
  every derived local id; changing it orphans everything already imported.

## Fixtures & open questions

`src/fixtures/analytic-summary.json` was synthesized from the ticket's payload
notes; an anonymized capture of the real analytics page (92 analytics) has
since confirmed its shape field-for-field: the response envelope, the API host
and path (`GetAnalyticSummary` with no query string), every `analytics[]`
field and type, `patients[]` (identical rows to `Report/GetReportPatientList`),
the .NET `/Date(ms-hhmm)/` `collectionDate` beside an ISO
`collectionPostedDate`, `abnormalFlag` values `null` / `H`, and result values
that mix numbers with free text (`...` on note rows, words like "Negative").
The capture decodes through the importer to one `Patient` plus 92
`Observation`s with no parse failures. It also showed `Dashboard/GetMyReports`
carrying a richer patient (`firstName`, `lastName`, `birthDate`, `gender`,
`healthCardNo`) than the summary's one display string — a possible follow-up
source for the `Patient`.

Still open:

- **Units** — the payload carries no unit, so a numeric result is a unitless
  `valueQuantity`. The rendered report (`Report/ViewReports`, HTML) has a unit
  column; recovering units would mean parsing that HTML, which the product
  decision (JSON over HTML) rules out for now.
- **`LIFELABS_TEST_SYSTEM`** — a namespaced placeholder; LifeLabs publishes no
  OID for `testCode`. The LOINC coding beside it is the standard one.
- **Province** — the API host is Ontario-only for v1.
- **Anonymizer artefacts** — the anonymizer rewrites the `/Date(` literal
  itself (`/Uwbx(…)/`), so an anonymized capture decodes with no
  `effectiveDateTime` and undated ids; that is the fixture pipeline's problem,
  not this decode's. It also leaves base64 URL path segments unscrambled while
  scrambling the same ids in the body.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [shoppers-drugmart-source AGENTS.md](../shoppers-drugmart-source/AGENTS.md)
  — the sibling bespoke-JSON source this one mirrors.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
