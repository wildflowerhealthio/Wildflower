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
  selected `Patient` plus one `Observation` per `entity.analytics[]` row
  (every analyte's latest values, **no unit** in the payload).
- `src/response-kinds/view-analytics-response-kind.ts` —
  `…/api/Report/ViewAnalytics?patientId=&testItemIds=<one id>` → one
  `Observation` per `entity.reports[]` row: one analyte's whole history, **with
  `testUnit`**, the source `reportId` as an identifier, and `comments` as a
  note. The SPA fires it only when the user clicks into an analyte, so the live
  collector rarely sees it; HAR imports of such a session do.
- `src/response-kinds/analyte-observation.ts` — what the two share: the id
  scheme, the `code` builder, the quantity/range/date parsers. The same draw of
  the same analyte gets the **same logical id** from either payload, so the
  unit-bearing `ViewAnalytics` row supersedes the unitless summary row on
  persist instead of duplicating it.
- `src/units.ts` — `LOINC_UNITS` (LOINC → the unit LifeLabs prints, for the
  unitless summary rows) and `ucumCodeFor` (LifeLabs display spelling → UCUM
  code, e.g. `x E9/L` → `10*9/L`). See [Units](#units).
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
- value: a numeric `testResultValue` → a `valueQuantity`; its `unit` is the
  payload's `testUnit` (`ViewAnalytics`) or, for the unitless summary, the
  `LOINC_UNITS` entry for the analyte's LOINC — none known ⇒ a unitless
  quantity, never a guess. A unit whose UCUM code `units.ts` knows gets
  `system`/`code` too. Anything non-numeric → `valueString`.
- `referenceRange` = the raw string as `text`, plus parsed `low`/`high` when it
  is a simple numeric interval (`4.0 - 11.0`, `120- 160`), or the one bound of
  a one-sided `<2.6` / `>=40`.
- `interpretation` = `abnormalFlag` when present.
- logical id = sanitized `testItemId` (base64 → FHIR-safe token: `+`→`-`,
  `/`→`.`, padding stripped) suffixed with the collection millis, so repeat
  draws of the same analyte across dates don't collide — and so both kinds
  agree on the id of one draw. When a capture omits
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

## Units

`GetAnalyticSummary` — the payload the live collector sniffs — has no unit
field. `ViewAnalytics` does (`testUnit`, e.g. `x E12/L`), but the SPA fires
it only per analyte the user clicks, and the product decision is not to make
the user click. So `src/units.ts` carries `LOINC_UNITS`, a researched table of
the unit LifeLabs prints for each analyte, keyed by the LOINC recovered from
`testItemId`. Rules for the table:

- An entry is added only from a real payload (`ViewAnalytics`'s `testUnit`)
  or a researched, source-cited mapping; an analyte not in the table stays a
  unitless quantity. Never infer a unit from a reference range alone.
- LifeLabs reports in Canadian SI units and spells powers of ten `x E9/L` /
  `x E12/L`; `ucumCodeFor` maps those spellings to UCUM (`10*9/L`, `10*12/L`).
- A `ViewAnalytics` row always wins over the table: it is the portal's own
  unit for that draw.

### The researched mapping

Fifty LOINCs were recovered from a real analytics capture (the anonymizer left
the `testItemId` URL segments intact) and researched against LOINC's property
and Canadian/LifeLabs sources; every entry was then **checked against the
reference range and value magnitude of a real, un-scrambled summary payload**
(committed, with ids, names, values and dates rewritten, as
`src/fixtures/analytic-summary-full.json`). What went into `LOINC_UNITS`, and
what was left out on purpose:

| Group       | LOINC → unit                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CBC         | `6690-2` WBC, `777-3` platelets, `751-8` / `731-0` / `742-7` / `711-2` / `704-7` differentials, `53115-2` immature granulocytes → `x E9/L`; `789-8` RBC → `x E12/L`; `718-7` Hgb, `786-4` MCHC → `g/L`; `4544-3` Hct → `L/L`; `787-2` MCV → `fL`; `785-6` MCH → `pg`; `788-0` RDW → `%`                                                         | Ranges in the real payload (`150 - 400`, `80 - 100`, `27.5 - 33.0`, `305 - 360`, `11.5 - 14.5`, `0.350 - 0.450`); RBC unit from a real `ViewAnalytics`                                                                                                                          |
| Chemistry   | Na `2951-2`, K `2823-3`, Ca `2000-8`, urea `22664-7`, fasting glucose `14771-0`, lithium `14334-7` → `mmol/L`; creatinine `14682-9`, urate `14933-6`, total bilirubin `14631-6` → `umol/L`; ALT `1742-6`, AST `1920-8`, alkaline phosphatase `6768-6` → `U/L`; albumin `1751-7` → `g/L`; eGFR `33914-3` → `mL/min/1.73m2`; HbA1c `4548-4` → `%` | LOINC `[Moles/volume]` / `[Enzymatic activity/volume]` property + Canadian SI convention, confirmed by the real ranges (`50-100` creatinine, `3.6 - 6.0` glucose, `35-52` albumin, `35-120` ALP); eGFR unit from LifeLabs' CKD-EPI 2021 notice; Ontario reports A1c as NGSP `%` |
| Lipids      | total `14647-2`, HDL `14646-4`, LDL `39469-2`, non-HDL `70204-3`, triglyceride `14927-8` → `mmol/L`                                                                                                                                                                                                                                             | LifeLabs non-fasting-lipids newsletter quotes `mmol/L`                                                                                                                                                                                                                          |
| Endocrine   | TSH `3016-3` → `mIU/L`; estradiol `14715-7`, PTH `14866-8` → `pmol/L`; progesterone `14890-8`, testosterone `14913-8` → `nmol/L`; prolactin `2842-3` and monomeric `42607-2` → `ug/L`                                                                                                                                                           | PTH from LifeLabs' reference-interval PDFs (`<7.0 pmol/L`); prolactin in `ug/L` is the Canadian convention (medium-high confidence)                                                                                                                                             |
| Urine strip | glucose `22705-8`, ketones `22702-5` → `mmol/L`                                                                                                                                                                                                                                                                                                 | LifeLabs' 2021 urinalysis notice quotes SI critical values; a "Negative" result stays a `valueString`, so the unit only lands on numeric rows                                                                                                                                   |
| Timing      | hours after meal `55420-4`, time since last dose `45359-7` → `h`                                                                                                                                                                                                                                                                                | Numeric in the real payload (`0`, `2`, `12.00`) with no range                                                                                                                                                                                                                   |

Deliberately **not** in the table: dimensionless numerics (urine pH `2756-5`,
specific gravity `5811-5`, chol/HDL ratio `32309-7`); ordinal and nominal
results (hepatitis serology, NAAT presence, urine colour/appearance/strip
presence codes, specimen source, collection date `33882-2` / time `49049-0`);
and the ones whose printed spelling is unverified (urine erythrocytes
`20409-9`, which arrived as "NEGATIVE"; NRBC `19048-8`, which arrived as `0`
with no range). Sources: LifeLabs' urinalysis-platform (2021),
Sysmex XN, CKD-EPI 2021, macroprolactin and non-fasting-lipids notices, its
BRL/VRL reference-interval PDFs, and the LOINC long common names.

Panel groupings by `testCode` prefix, for eyeballing: `TR10477-8W` CBC;
`TR10453-9I` urinalysis; `TR11629-3` / `-3V` lipids; `TR10149-3` / `-3H` /
`-3M` creatinine + eGFR; `TR10278-0A` / `-0V` lithium; `TR10714-4P` and
`TR10690-6P` urine NAAT (gonorrhoea, chlamydia); `TR11494-2A` prolactin +
monomeric. The `V` suffix recurs across unrelated analytes, so it is a
version/venue flag rather than a panel.

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

- **Units** — `GetAnalyticSummary` carries none; see [Units](#units) for the
  researched `LOINC_UNITS` table and what is allowed into it. Analytes not
  listed import unitless.
- **`LIFELABS_TEST_SYSTEM`** — a namespaced placeholder; LifeLabs publishes no
  OID for `testCode`. The LOINC coding beside it is the standard one.

## The codes

Researched against LOINC from the analytics capture's `testItemId`s
(`base64('<testCode>__<loinc>;')`):

- **The embedded code is LOINC.** Every decoded suffix checked resolves to the
  analyte the row names: `6690-2` Leukocytes (WBC), `4544-3` Hematocrit,
  `2951-2` Sodium, `2823-3` Potassium, `14682-9` Creatinine [Moles/volume],
  `1742-6` ALT, `14771-0` Fasting glucose. Hence the `LOINC_SYSTEM` coding.
- **`testCode` is not LOINC.** It only looks like one: `TR10477-8W`'s digits
  `10477-8` are LOINC's neuron-specific enolase stain, nothing to do with the
  CBC it labels. It is LifeLabs' internal test-request code — `TR` + number,
  with a trailing letter that varies across _variants of the same panel_
  (`TR10149-3`, `TR10149-3H`, `TR10149-3M` all carry creatinine `14682-9`;
  `TR11629-3` / `TR11629-3V` share their whole analyte list). Keep it in
  `LIFELABS_TEST_SYSTEM` and never derive a LOINC from it.
- **`33882-2` is "Collection date of Specimen"**, and rides in several panels
  (`TR10453-9I`, `TR10278-0A`, `TR10690-6P`, `TR10714-4P`) as a row of its own.
  It decodes to an Observation like any other row — a non-numeric
  `valueString` — which is faithful to the portal, if noisy; folding it into
  `effectiveDateTime` is a possible follow-up.
- **Province** — the API host is Ontario-only for v1.
- **Anonymizer artefacts** — captures anonymized before #630 have the
  `/Date(` literal itself rewritten (`/Uwbx(…)/`), so they decode with no
  `effectiveDateTime` and undated ids; re-anonymize from the original rather
  than working around it here. The anonymizer still leaves base64 URL path
  segments unscrambled while scrambling the same ids in the body.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [shoppers-drugmart-source AGENTS.md](../shoppers-drugmart-source/AGENTS.md)
  — the sibling bespoke-JSON source this one mirrors.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
