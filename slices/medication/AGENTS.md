# AGENTS.md — slices/medication

Everything about a patient's medication list: the abstract name-matching
fundamentals, plus the two features built on them — drug-interaction checking
(**DDInter**) and patient-support / drug-sponsorship programs (**innoviCares**,
**RxHelp**). The matcher is a shared base neither feature owns; each maps its own
catalog onto it.

## Packages

- `medication-core` — the pure matching layer **plus the FHIR R4 adapters**,
  shared by the rest of the slice. The root export is the matcher: the minimal
  `Medication` value type adapters map their resources onto, `normalizeName` /
  `tokenize` (markup, marks, diacritics and dosage tokens stripped), `scoreName`
  — the exact / strong / partial containment scoring every consumer's matcher is
  built from — and `dedupeMedicationsByName`, which collapses exact-name
  duplicates to the most recent (`authoredOn`) instance. The `medication-core/fhir`
  subpath is the `MedicationRequest → Medication` / `MedicationView` adapter (the
  core `Medication` for matching, plus the display fields — DIN, description,
  prescriber, notes, repeat counts, the dispensing store's link, estimated
  next-fill date) and the `hasRefill` rule the calendar shares. Each field is
  one small exported accessor (`dinOf`, `descriptionOf`, `repeatsAvailableOf`,
  `storeLinkOf`, …) over the decoded `fhir-r4` `MedicationRequest.Type`,
  reading only the conventional slots the pharmacy sources write (canonical
  `CanadianCodingSystem.Din`, `WildflowerExtension.RepeatsAvailable`,
  `WildflowerExtension.MedicationDescription`,
  `dispenseRequest.performer.reference`) — no pre-promotion fallbacks and no
  vendor urls. No DOM, no platform imports.
- `medication-interaction-core` — the pure interaction layer. The compact
  bundled-file schema (`DdinterFile`: a drug table plus
  `[indexA, indexB, severityCode]` triples) and its decoder to an
  `InteractionCatalog`; the CSV-to-compact converter (`parseDdinterCsv` /
  `buildDdinterFile`); the severity model (Major > Moderate > Minor > Unknown,
  rank = file code); the curated OTC categories (`otcCategories`, each a name
  plus its `OtcDrug` actives) and non-drug names (`nonDrugNames`);
  `matchCatalogDrugs` (every ingredient of a name, via `medication-core`'s
  scoring); `findInteractions`, the grouped report; and the severity tally
  helpers plus `worstSeverity`. No DOM, no FHIR, no platform imports.
- `medication-interaction-react` — browser UI: `InteractionsView` (three
  sections of collapsible group cards. A header is a disclosure toggle on the
  left beside a strip of named severity pips — one per interacting counterpart,
  each a button naming it on hover and unfolding it on click, however deeply
  nested; the toggle and pips never nest. Rows show only while a group is open,
  with a severity `StatusBadge` and a "Details" link per row to DDInter). With a
  `prescriberOf` lookup it shows a `PrescriberAvatar` per medication in the
  "Between your medications" section and rings any cross-prescriber interaction.
  It takes the core `Medication` values; the FHIR `MedicationRequest` adapter is
  `medication-core/fhir`'s, which the app already runs for the medications
  list.
- `medication-sponsorship-core` — the pure sponsorship layer. Province model,
  the normalized `SponsoredDrug` shape, decoders for each program's raw JSON
  list, brand+generic matching (best single drug per medication, brand preferred
  at equal confidence), and province-aware grouping. No DOM, no FHIR, no platform
  imports. The name normalization, containment scoring and the minimal
  `Medication` value type come from `medication-core` and are re-exported here
  unchanged, so adapters keep mapping onto this package's `Medication`.
- `medication-sponsorship-react` — browser UI: the province picker, the flat
  medications view (active first, newest-authored first; name, DIN/description,
  repeats, prescriber, pharmacy links — fill timing and eligibility chips live
  on the calendar and savings views), the savings view (`SavingsView`: one
  section per program with its site-sourced description in
  `program-descriptions.ts`, eligible medications chipped per the selected
  province — with completed-but-still-eligible prescriptions dimmed at the
  bottom of each program's list (`pastMedications`; program lists only, never
  the uncovered section) — then a "No known savings program" section). It renders
  the `MedicationView`s `medication-core/fhir` builds; it owns no FHIR adapter of
  its own.
- `medication-calendar-core` — the pure calendar layer: the next-fill /
  exhaustion date math (`nextFillDate`, which reads a `SupplyDuration` from
  `slices/emr/fhir-utility` — a supply duration is a FHIR concept, not a
  calendar one), `deriveCalendarEvents` (pickup on the next-fill date with
  repeats left; a renewal appointment one week before and a marker on the
  exhaustion day without; same-day events of one kind merge into a single
  fluently-titled event), and the Sunday-start 42-cell `monthGrid`. Pure
  date/calendar arithmetic on Effect `DateTime`; no DOM, no FHIR wire
  schemas, no platform imports.
- `medication-calendar-react` — browser UI: `CalendarView`, a month grid with
  previous/next navigation rendering the derived events into day cells; below
  640px the grid gives way to a day-grouped schedule stack scrollable both
  ways from a red "Now" line. Maps `MedicationView`s (from
  `medication-core/fhir`) onto `medication-calendar-core`'s inputs.

## Data

The app bundles the whole DDInter set as one compact JSON
(`apps/medications-app/src/data/ddinter/ddinter.json`), generated by
`vp run -F medications-app data:ddinter -- <dir>` from DDInter's per-ATC
download CSVs (`ddinter_downloads_code_<letter>.csv`, columns `DDInterID_A,
Drug_A, DDInterID_B, Drug_B, Level`). The converter dedupes pairs that recur
across the ATC files (most severe level wins) and drops self-pairs; the file
schema's filter rejects out-of-range, unordered or duplicate pairs, so a
hand-edited file fails to decode rather than misreporting. The converter throws
on an unrecognised `Level` or a missing column instead of dropping rows — the
data is expected to be exactly DDInter's.

The bundled file holds DDInter's full set (all eight per-ATC download CSVs —
A, B, D, H, L, P, R, V), retrieved 2026-09-03: 1,939 drugs and 160,235 pairs.
Of `nonDrugNames`, the data carries Activated charcoal, Caffeine, Cannabidiol,
Ethanol and Nicotine; Alcohol, Grapefruit, Grapefruit juice, Tobacco, Food and
Cannabis are not present under those names. Two things remain to verify
against the live site (<https://ddinter.scbdd.com/>): DDInter's licence / terms
(record them here), and the drug-detail URL scheme assumed in `ddinterDrugUrl`
(`ddinter.ts`).

## Rules

### Matching (`medication-core`)

- Keep it catalog-agnostic. A consumer decides _which_ names to score
  (brand vs generic, one drug vs many) and how to break ties; this package only
  says how confidently one name matches another.
- `normalizeName` is idempotent by construction (token filtering, not regex
  substitution) and the property tests pin it — keep new noise rules as token
  predicates.
- **The FHIR R4 adapters live behind the `medication-core/fhir` subpath, never
  the root export.** The root entry stays pure — importing `scoreName` from
  `medication-core` must not pull `fhir-r4`'s schemas into a consumer's bundle.
  Adding an entry means a new key in `vite.config.ts`'s single `pack.entry`
  and a matching `exports` key.
- The two feature cores (`medication-sponsorship-core`,
  `medication-interaction-core`) stay FHIR-agnostic. `fhir-r4` is this package's
  dependency alone; a feature core that wants a resource takes the
  `medication-core/fhir` output, it does not decode one itself.
- This package is a `fhir-r4` consumer, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md) apply.
  The accessors read the typed slots directly and never re-declare a FHIR shape
  locally. The two slots `fhir-r4` leaves untyped are decoded with its own
  schemas: `medication[x]` already holds **decoded** values (a `Coding.system`
  is a `URL`, not a string), so it goes through `Schema.typeSchema` of
  `CodeableConcept` / `Reference`; `contained` holds raw wire JSON, so an entry
  goes through the full `Medication.Schema`. And `vp pack` is the
  gate for the TS2883 dts trap, not `vp check` — when the adapter's inferred
  types change, run `vp run -F medication-core build`.
- The adapter depends on `medication-calendar-core` for `nextFillDate`, so the
  matching base imports one feature core. Keep it that way round: nothing in
  `medication-calendar-core` may import `medication-core`.

### Interactions (`medication-interaction-*`)

- Keep `medication-interaction-core` FHIR-agnostic; adapters map onto
  `medication-core`'s `Medication`.
- Matching returns **every** contained catalog drug (a combination product
  yields each ingredient), falling back to partial matches only when nothing
  is contained. New heuristics belong in `match.ts` with tests.
- Rows are medications, groups are what they interact with. A row summarises
  every ingredient pair between two drug sets as the worst severity listed
  (a combination product is one row, not one per ingredient), and the drug
  on that worst pair is the row's "Details" link target. In the medications
  section a pair is listed twice, once under each medication (the UI halves
  the row total for its summary).
- The far side of a non-drug or OTC group is never a patient drug: a drug any
  medication resolved to is reported under `medications` only, an OTC entry
  that is also a non-drug (nicotine) under `nonDrugs` only. The non-drug
  section is data-driven — it holds whatever `nonDrugNames` entries the
  bundled catalog actually carries, and the UI explains an empty section when
  it carries none. Empty groups and categories are omitted from the report.
- Every list is in **severity-count order**: more Major first, ties by
  Moderate, then Minor, then Unknown, then name. Rows within a group are
  most-severe first, then name. `compareTallies` is the one comparator.
- The pip strip is one pip per interacting counterpart (a card's other
  medications, or a category's OTC actives), most severe first, capped at 12 in
  the UI; the remainder collapses into a `+N more` marker. Because the lists are
  already in severity-count order, the cap keeps the most severe.
- Open/closed state is local to `InteractionsView`, keyed by medication id,
  catalog index, or category/entry name; nothing persists.
- The compact JSON is excluded from formatting in the root `vite.config.ts`
  (`fmt.ignorePatterns`); regenerate it with the script, never edit by hand.

### Sponsorship (`medication-sponsorship-*`)

- Keep `medication-sponsorship-core` FHIR-agnostic. The FHIR `MedicationRequest`
  mapping lives in `medication-core/fhir`; `medication-sponsorship-react` renders
  what it returns.
- **"Empty province coverage means everywhere."** A raw entry with no province
  restriction (innoviCares empty string, RxHelp empty array) is expanded to
  every province at decode time so downstream coverage is a membership check.
  If this convention changes, change it in the two decoders only.
- Matching is deliberately fuzzy (normalized token containment). Heuristics
  about _how confidently a name matches_ belong in `medication-core`;
  heuristics about _which sponsored drug wins_ belong in this package's
  `match.ts`. Both with property tests.

## References

- [Architecture / slice layering](../AGENTS.md)
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — property tests are the default here
