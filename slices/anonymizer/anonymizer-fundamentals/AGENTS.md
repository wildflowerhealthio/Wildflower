# AGENTS.md — slices/anonymizer/anonymizer-fundamentals

The **format-agnostic upstream** of the anonymizer slice: the value a picker
produces, the contract every format binding implements, and the pure routing
helpers the shell drives the closed registry with. It is to this slice what
`importer-fundamentals` is to the importer slice — the layer a concrete binding
(`har-anonymizer-*`, `pdf-anonymizer-*`) sits on top of.

No DOM, no `fs`, no React: pure data and functions.

## Shape

- `src/picked-file.ts` — **`PickedFile`**, a file as name plus raw bytes.
  Bytes, not text, so the picker stays format-blind (HAR decodes UTF-8 JSON, a
  PDF decodes binary). Structural, so a test builds one from a literal.
- `src/format-descriptor.ts` — **`AnonymizerFormatDescriptor<T>`**, "an
  anonymizable file format" as one value a closed registry lists: `format`
  (the registry key), `display`, `accept` (picker `accept` tokens — a hint,
  never the decision), `detect` (cheap syntactic identification: magic bytes,
  an extension), and `decode(file) → Effect<T, DecodeFailure>` (the real
  parse; effectful because PDF extraction is asynchronous; requires no
  services). **`DecodeFailure`** carries the format's own user-facing
  sentence — what went wrong stays the binding's business, what the user can
  do about it is the only part that crosses this seam.
- `src/identify.ts` — **`identify`** (first descriptor whose `detect` claims
  the file — registry order is priority order, crisp magic-byte tests first)
  and **`acceptFor`** (the joined, deduplicated `accept` attribute).

## Layering

Depends only on `effect`. Names no file format and no UI framework. Never
imports a `*-anonymizer-core`, a `*-anonymizer-react`, or the shell.

## Guardrails

- **`detect` is syntactic, `decode` is the parse.** Detection must stay cheap
  enough to try every registered format on one picked file; a full parse in
  `detect` would run every format's parser on every pick.
- **Nothing behind the contract writes.** `decode` takes no services; the
  registry's panels download blobs, never call a client.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [importer-fundamentals AGENTS.md](../../importer/importer-fundamentals/AGENTS.md)
  — the sibling contract this package mirrors.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
