# AGENTS.md — slices/medication-sponsorship

Matches a patient's medications against Canadian patient-support / drug-sponsorship
programs (**innoviCares** and **RxHelp**) and groups them for display.

## Packages

- `medication-sponsorship-core` — the pure layer. Province model, the normalized
  `SponsoredDrug` shape, decoders for each program's raw JSON list, brand+generic
  matching (best single drug per medication, brand preferred at equal
  confidence), and province-aware grouping. No DOM, no FHIR, no platform
  imports. The name normalization, containment scoring and the minimal
  `Medication` value type come from
  [`medication-matching-core`](../medication-matching/AGENTS.md) and are
  re-exported here unchanged, so adapters keep mapping onto this package's
  `Medication`.
- `medication-sponsorship-react` — browser UI: the province picker and the flat
  medications view (active first, newest-authored first; per-row sponsorship
  chip), plus the `MedicationRequest → MedicationView` adapter (the core
  `Medication` for matching, plus carebook display fields — DIN, description,
  prescriber, notes, repeat counts).

## Rules

- Keep `medication-sponsorship-core` FHIR-agnostic. The FHIR `MedicationRequest` mapping
  lives in `medication-sponsorship-react` (it already depends on `fhir-r4`).
- **"Empty province coverage means everywhere."** A raw entry with no province
  restriction (innoviCares empty string, RxHelp empty array) is expanded to
  every province at decode time so downstream coverage is a membership check.
  If this convention changes, change it in the two decoders only.
- Matching is deliberately fuzzy (normalized token containment). Heuristics
  about _how confidently a name matches_ belong in `medication-matching-core`;
  heuristics about _which sponsored drug wins_ belong in this package's
  `match.ts`. Both with property tests.
- The `MedicationRequest → MedicationView` adapter re-decodes an **already-decoded**
  `fhir-r4` resource, so `uri`/`url` fields (`Coding.system`) arrive as `URL`s, not
  strings — a `system: Schema.String` slot silently fails the whole concept. See the
  [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md);
  the adapter already coerces via `nullableUri`.

## References

- [Architecture / slice layering](../AGENTS.md)
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — property tests are the default here
