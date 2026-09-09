# AGENTS.md — slices/anonymizer/pdf-anonymizer-core

The **PDF engine** of the anonymizer slice: the `PositionedTextDocument` Effect
Schema (the `wildflower-positioned-text` v1 format), literal-substring
substitution with class-preserving same-length masking, and the
anonymized-JSON file-name helper. No DOM, no `fs`, no React — pure data and
functions.

## Shape

- `src/positioned-text.ts` — **`PositionedTextDocument`** Effect Schema
  (`{ format, version, fileName?, pages: [{ pageNumber, width, height, runs:
[{ text, x, y, width, fontSize, fontName? }] }] }`), top-left y origin.
  **`PositionedTextFromJson`** (`Schema.parseJson` analog of
  `LogFromHarJson`) for round-tripping through JSON.
- `src/substitution.ts` — **`SubstitutionRule`** (`{ id, text }`),
  **`maskSameLength`** (class-preserving: `A→X`, `a→x`, digit→`0`,
  punctuation/space kept; idempotent), **`applySubstitutions`** (doc × rules →
  `{ document, ruleMatches }` — case-insensitive literal, global, within-run
  only, rules applied in order over the previous result).
- `src/anonymized-json-file-name.ts` — **`anonymizedJsonFileName`**
  (`<stem>.anonymized.json`, sanitisation mirroring `har-anonymizer-react`'s
  `anonymizedFileName`).

## Layering

Depends only on `effect`. Names no UI framework and no extraction library.
Never imports `pdf-anonymizer-react`, `pdfjs-dist`, or a DOM type.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document.

- `substitution.test.ts` — masking preserves length, is idempotent,
  class-preserving; substitution is case-insensitive, global, within-run,
  in-order; no rule text survives; non-matching runs are byte-identical.
- `positioned-text.test.ts` — schema accepts/rejects the right shapes; JSON
  round-trip via `PositionedTextFromJson`.
- `anonymized-json-file-name.test.ts` — extension stripping, sanitisation,
  hidden-file fallback, filesystem-safe characters.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [har-anonymizer-react download-har.ts](../har-anonymizer-react/src/download-har.ts)
  — the HAR file-name helper this package mirrors.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
