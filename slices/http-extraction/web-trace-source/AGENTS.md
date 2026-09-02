# AGENTS.md — slices/http-extraction/web-trace-source

The **web-trace source**: the catch-all recording entity and the capture-time
body policy that define how any HTTP exchange becomes a FHIR `DocumentReference`
trace. Unlike the other `*-source` packages (which export a `SourceDescriptor`),
this package exports a **factory** — `makeRawExchangeResponseKind`, parameterized
with a per-run `sessionId` and `BodyPolicy` — because the recording entity
closes over session state that differs per dispatch.

## Shape

- `src/body-policy.ts` — the capture-time body policy: `contentTypeTokens` (the
  allowlist token decomposition), `isAllowlisted`, and `decideBody` (the
  `Effect`-shaped decision of stored vs. skipped, always carrying `size` and
  `hash`). `BodyPolicy` is the config-surface type
  (`{ bodyContentTypes, maxBodyBytes }`).
- `src/response-kinds/raw-exchange-response-kind.ts` — the catch-all response
  kind factory. `makeRawExchangeResponseKind({ sessionId, policy })` returns an
  `HttpResponseKind<DocumentReferenceType>` whose `tryRecognize` is total
  (`Some` for every URL, `CATCH_ALL` specificity, no `source`), and whose
  `parse` encodes the exchange through `web-trace-core`'s codec.
- `src/index.ts` — barrel re-exporting both modules.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `Specificity`),
`web-trace-core` (codec, provenance, capture utilities), and `effect` — nothing
else. In particular it must **never** import anything from `slices/collector`
(`web-trace-collector` depends on this package; the live config/plan/form are
its concern).

## Invariants

These are the web-trace recording's invariants. They originate in the
[web-trace-collector AGENTS.md](../../collector/web-trace-collector/AGENTS.md)
and apply identically here — the source package is where the implementation
lives.

### 1. No URL filtering, ever

`tryRecognize` is **total** — it returns `Some({ specificity: Specificity.CATCH_ALL })`
for every URL, with **no `source`** (it records, it does not import — there is no
identity to mint and nothing to adopt). It never throws, even on a malformed or
relative URL. The allowlist governs **bodies**, never whether an exchange is
recorded. **The catch-all matters twice**: coverage, and the fact that
`CollectorBridgeMessageHandler` fires `CancelSnifferRequest` at responses **no
entity claims** — a `None` or a throw here would abort the user's own browsing.

### 2. Redaction never happens on the write path

What is stored is what was seen. Nothing under `src/` may import
`web-trace-core/pseudonymizer`.

### 3. `parse` never fails the run

One unparseable exchange must not lose a session. `parse` fails only for the one
exchange that hit the problem — via `ParseError`, so the tracker records a failed
sniff and the run keeps draining. A body that is **not UTF-8 decodable is stored
base64**, which is why `decideBody` reads `bytes()` and never `text()`.

## Traps

- **The encoding lives in `web-trace-core` and is imported, never re-derived.**
  `toDocumentReference` is the only way a trace resource is built here.
- **This kind is _not_ adopted, and must not be.** Its `tryRecognize` mints no
  `source`, so it is never mapped through `adoptUnderRecognizedRoot`.
- **The factory is parameterized per-run, unlike static source kinds.** Two
  dispatches produce structurally unequal kinds — which is why
  `collector-registry`'s union-wide test compares a plan _identity projection_
  rather than deep equality.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [web-trace-collector AGENTS.md](../../collector/web-trace-collector/AGENTS.md)
  — the live collector built from this entity (config, plan, form), and the full
  set of invariants.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the
  codec this package encodes through.
