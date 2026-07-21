# AGENTS.md — slices/medication-sponsorship

Matches a patient's medications against Canadian patient-support / drug-sponsorship
programs (**innoviCares** and **RxHelp**) and groups them for display.

## Packages

- `medication-sponsorship-core` — the pure layer. Province model, the normalized
  `SponsoredDrug` shape, decoders for each program's raw JSON list, fuzzy
  brand+generic name matching, and province-aware grouping. No DOM, no FHIR, no
  platform imports; the matcher works on a minimal `Medication` value type so
  adapters map their own resources onto it.
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
- Matching is deliberately fuzzy (normalized token containment). New match
  heuristics belong in `match.ts` with property tests.

## References

- [Architecture / slice layering](../AGENTS.md)
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — property tests are the default here
