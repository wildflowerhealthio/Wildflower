# AGENTS.md — slices/anonymizer/pdf-anonymizer-core

The **PDF engine** of the anonymizer: literal-substring substitution with
class-preserving same-length masking over a `Document.Type`,
frequent-substring suggestions, and the anonymized-JSON file-name helper. The
`Document.Schema` schema itself lives in the `positioned-text` package
(`slices/file-formats`); this package masks it. No DOM, no `fs`, no React —
pure data and functions.

## Shape

- `src/substitution.ts` — **`SubstitutionRule`** (`{ id, text }`),
  **`maskSameLength`** (class-preserving over an allowlist: whitespace and
  punctuation kept; uppercase/titlecase→`X`, digit→`0`, everything else →`x`,
  including caseless scripts, combining marks and symbols; preserves the
  code-point count; idempotent), **`applySubstitutions`** (doc × rules →
  `{ document, ruleMatches }` — literal match by `matchKey`, global,
  within-run only, rules applied in order over the previous result; a match
  masks its original code points plus the marks on them).
- `src/match-key.ts` — **`matchKey`** (per code point: NFKD, combining marks
  dropped, case folded — the equivalence rules match by, and the key the
  suggestion tally and the panel's suggestion dedupe use), **`keyedText`**
  (the key plus each key unit's span in the original text).
- `src/anonymized-json-file-name.ts` — **`anonymizedJsonFileName`**
  (`<stem>.anonymized.json`, sanitisation mirroring `har-anonymizer-react`'s
  `anonymizedFileName`).

## Layering

Depends on `positioned-text` (the schema it masks) and `effect`. Names no UI
framework and no extraction library. Never imports `pdf-anonymizer-react`,
`pdfjs-dist`, or a DOM type.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document.

- `substitution.test.ts` — masking preserves length, is idempotent,
  class-preserving; substitution matches by `matchKey`, is global, within-run,
  in-order; no rule text survives; non-matching runs are byte-identical.
  Properties draw full-Unicode strings (`unit: 'binary'`).
- `match-key.test.ts` — case, accent, normalization-form and compatibility
  folding; key spans map back to the original code points.
- `anonymized-json-file-name.test.ts` — extension stripping, sanitisation,
  hidden-file fallback, filesystem-safe characters.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the anonymizer's package roles.
- [positioned-text AGENTS.md](../../file-formats/positioned-text/AGENTS.md) —
  the `Document.Schema` schema this engine masks.
- [har-anonymizer-react download-har.ts](../har-anonymizer-react/src/download-har.ts)
  — the HAR file-name helper this package mirrors.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
