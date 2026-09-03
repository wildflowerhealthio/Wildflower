# AGENTS.md — slices/medication-matching

The abstract fundamentals of matching a patient's medication names against a
drug catalog, shared by the medication slices. Like `http-extraction`, two
slices build on it and neither owns it: `medication-sponsorship` (patient
support programs) and `medication-interaction` (DDInter drug interactions).

## Packages

- `medication-matching-core` — the pure layer, and currently the only package.
  The minimal `Medication` value type adapters map their resources onto,
  `normalizeName` / `tokenize` (markup, marks, diacritics and dosage tokens
  stripped), `scoreName` — the exact / strong / partial containment scoring
  every consumer's matcher is built from — and `dedupeMedicationsByName`, which
  collapses exact-name duplicates to the most recent (`authoredOn`) instance. No
  DOM, no FHIR, no platform imports.

## Rules

- Keep it catalog-agnostic. A consumer decides _which_ names to score
  (brand vs generic, one drug vs many) and how to break ties; this package only
  says how confidently one name matches another.
- `normalizeName` is idempotent by construction (token filtering, not regex
  substitution) and the property tests pin it — keep new noise rules as token
  predicates.

## References

- [Architecture / slice layering](../AGENTS.md)
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — property tests are the default here
