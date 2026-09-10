# AGENTS.md — slices/anonymizer/har-anonymizer-core

The **HAR engine** of the anonymizer slice: the shape-preserving pseudonymizer
that turns a raw captured session into one that can leave the device. This
package is the privacy boundary: a change here changes what leaves the device.
Read [Anonymization Explanation](../docs/Anonymization%20Explanation.md)
before changing anything.

No DOM, no `fs`, no React.

## Shape

- `src/hmac.ts` — the per-export key: `mintExportSalt`, `importExportKey`,
  `hmac`, and `WebCryptoUnavailable`. Every pseudonym derives from this key;
  a salt must never be reused across exports.
- `src/leaves.ts` — the leaf walkers (`mapExchangeLeaves` over a
  `TraceExchange`, `mapEntryLeaves` over an `HttpArchive.Entry`) and the path
  vocabulary (`bodyPath`, `headerPath`, `cookiePath`, …). The counting pass and
  the rewriting pass share these walkers, so the two passes cannot see
  different paths.
- `src/redact.ts` — the policy and the rewrite: `buildRedactionPolicy` /
  `buildPolicyForLog` (count distinct values per path, decide the enum
  carve-out, namespace URIs, per-path overrides), `redactExchange` /
  `redactSession` and the HAR-native `redactEntry` / `redactLog`, the
  value→pseudonym table, and `PseudonymSpaceExhausted`.
- `src/shapes.ts` — `detectShape` and `generateFake`: the shape classes
  (`iso8601`, `jwt`, `uuid`, `email`, …, `freeText`) that make a pseudonym keep
  its original's shape.
- `test-fixtures/readme-httpbin.har.json` — the user-supplied capture the
  no-alnum-freetext regression test replays.

## Layering

Depends on `http-archive` (the `HttpArchive` projection — the HAR _format_ is
owned by the `file-formats` slice), `web-trace-core` (`TraceExchange`),
`kitchen-sink/schema` (`JsonValue`), and `effect`. Never imports
`har-importer-core`, a `*-react` package, the shell, or anything that writes.

## Guardrails

- **Reuse one policy per export, never across exports.** The accumulating
  value→pseudonym table is what keeps equal values equal within an export and
  what would make two exports linkable if shared.
- **Same walkers for counting and rewriting.** A path the counter never saw is
  a path the rewriter treats as unknown (pseudonymize) — keep it that way.
- **The engine answers to its own tests.** `redact.test.ts`, `shapes.test.ts`,
  `no-alnum-freetext.test.ts`, and `redacted-fixture.test.ts` (the emitted
  fixture held to the published HAR 1.2 schema) live beside the code; a
  behavior change here must change a test here.

## References

- [Anonymization Explanation](../docs/Anonymization%20Explanation.md) — the
  design and its stated limits. Required reading.
- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [har-anonymizer-react AGENTS.md](../har-anonymizer-react/AGENTS.md) — the
  panel that drives this engine.
- [http-archive AGENTS.md](../../file-formats/http-archive/AGENTS.md) — the
  owner of the `HttpArchive` seam this package reads.
