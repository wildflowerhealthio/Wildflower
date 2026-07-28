# AGENTS.md — slices/web-trace/web-trace-core

The pure layer of the web-trace slice. No DOM, no `fs`, no UI, no store — one
vocabulary, and the translations built on it.

Read the [Redaction Explanation](./docs/Redaction%20Explanation.md) before
touching anything under `src/pseudonymizer/`.

## Layering

`web-trace-core` is a `-core` package and follows the rule in
[slices/AGENTS.md](../../AGENTS.md): adapters may depend on it, it depends on no
adapter.

It sits below both a collector (which captures) and a React app (which reviews
and exports), which is why it is its own slice rather than a package inside
either. See the [slice AGENTS.md](../AGENTS.md) for that argument in full.

## Module layout

- **`src/trace-exchange.ts`** — the vocabulary. `TraceExchange` is one recorded
  HTTP exchange; `StoredBody` / `SkippedBody` is the captured-or-recorded-omission
  split; `TraceTimings` is what the capture could measure.
- **`src/codec/`** — `TraceExchange` ⇄ FHIR R4 `DocumentReference`.
  `systems.ts` holds the private systems and extension URLs;
  `fhir-duration.ts` is the `Duration` ⇄ FHIR `Duration` unit conversion.
- **`src/capture/`** — the capture-side primitives both consumers share:
  the content-type rule, the SHA-256 every body carries, and `storeBodyVerbatim`.
  Policy is _not_ here — see the trap below.
- **`src/provenance/`** — the receipt for a resource a collector derived from a
  response: `captureProvenance` builds the trace and links it both ways;
  `toExchangeFields` is the one statement of the response → exchange field
  mapping (the recorder's entity spreads it too); `makeFhirProvenanceCapture`
  is the hook factory a production collector states as its plan's
  `captureProvenance`. `CapturedResponse` names the readable surface of
  `collector-fundamentals`' `RemoteResponse` _structurally_ — this package
  sits below the collector slice and must not import it, so the boundary is a
  shape, not a dependency.
- **`src/pseudonymizer/`** — the export boundary's redactor. `shapes.ts` detects
  what a value looks like and generates another value that looks the same,
  `leaves.ts` decides what counts as a leaf, `redact.ts` is the two-step
  policy/rewrite engine, and `hmac.ts` is the Web Crypto seam.
- **`src/har/`** — HAR 1.2 emission.
- **`src/test-helpers.ts`** — `fast-check` arbitraries for realistic captures,
  exported as `web-trace-core/test-helpers` so downstream packages can reuse them.

## Traps

- **The sniffer field types are imported, not restated.** `TraceExchange` takes
  `url` / `status` / `statusText` / `headers` from `browser-sniffer-core`'s
  `ResponseStartMessageBody.fields`, so a change to what the sniffer reports is a
  type error here rather than silent drift. Don't "simplify" them to bare
  `Schema.String`. `trace-exchange.test.ts` pins the referential identity.
- **There is no request side, and none is invented.** The sniffer reports no
  method, no request headers, and no request body. A `TraceExchange` therefore
  cannot tell a GET from a POST to the same URL. Anything downstream that wants
  one has to say it does not have it, not guess.
- **`TraceTimings` is `Duration` in app and milliseconds on the wire.** The
  fields are `wait` / `receive` decoded and `waitMs` / `receiveMs` encoded, via
  `Schema.fromKey`. Nothing downstream of a decode has to know what unit a bare
  number was in, and the wire — which has no type to carry a unit — keeps saying
  so in the key. `null` means unmeasured; `Duration.zero` is a measurement of
  zero.
- **`Schema.DurationFromMillis` on its own is not enough.** It is built on
  `NonNegative`, which admits `+Infinity`, and `JSON.stringify(Infinity)` is
  `null` — exactly the value `TraceTimings` uses for "not measured", so an
  infinite duration round-trips through JSON into a plausible absence. Timings
  go through `DurationFromJsonNumberMillis`, which composes `Schema.JsonNumber`
  in front; don't unwrap it. Negatives are the same class of trap:
  `Duration.millis(-1)` is silently `Duration.zero`.
- **Timing arbitraries draw whole microseconds, not raw doubles.**
  `Duration.millis` is canonical only at microsecond resolution or coarser:
  `Duration.millis(4999.9999999999995)` is `Nanos:5000000000`, which encodes to
  `5000` and decodes back to `Millis:5000`. Equal by `Duration.equals`, different
  by `toEqual`, so raw doubles fail the round-trip property on Duration's
  internals rather than on anything this package does.
- **`{sessionId}-{requestId}` is the identity of an exchange.** The sniffer
  already assigns a correlation id per request, so ids are deterministic without
  threading a counter through a parse, retried writes are idempotent upserts, and
  two sessions cannot collide.
- **The encoding has exactly one definition — import it, never reimplement it.**
  A second copy drifts, and already-recorded sessions stop decoding. The private
  systems and extension URLs in `src/codec/systems.ts` are part of the persisted
  wire format: that file is append-mostly.
- **The encoding is a schema, not a pair of functions.**
  `TraceExchangeFromDocumentReference` is the definition;
  `toDocumentReference` / `fromDocumentReference` are `Schema.encode` /
  `Schema.decode` of it, and `TraceExchangeFromFhirJson` composes it with
  `DocumentReference.Schema` to start from raw FHIR JSON. Both directions fail
  with a `ParseError`, so the codec composes into a struct or a refinement like
  any other schema — don't reintroduce a bespoke error type.
- **Every extension url is absolute, nested ones included.** FHIR permits a bare
  token for a sub-extension's `url`, but a token like `name` only means anything
  next to a parent nobody carries around. `systems.ts` names each one and a
  property test fails if a bare token creeps back in.
- **Timings are `valueDuration`, which needs `Duration` registered in
  `fhir-r4`.** The registry treats an unregistered `value[x]` datatype as decode
  to `null` / fail on encode, so a `valueDuration` only round-trips because
  `data-types/complex/duration.ts` registers itself. If timings start silently
  arriving as `null`, that registration is what to check.
- **A `valueDuration` is parsed, not read.** `DurationFromFhirDuration` is the
  schema; it interprets the UCUM `code` the resource states, so a timing written
  in seconds decodes to a second-sized `Duration` and one in a unit with no
  fixed length (`mo`, `a`) fails rather than being averaged. Reaching for
  `.valueDuration?.value` instead reintroduces exactly the bug that motivated
  it: everything silently read as milliseconds. `readTimings` therefore works on
  the _decoded_ side, which is why `timings` is omitted from the struct the rest
  of the decode goes through.
- **There are two body policies, and the split is deliberate.** A recorder
  (`web-trace-collector`) stores under an allowlist and a `maxBodyBytes` cap,
  because an exploratory session of a whole portal balloons otherwise. A
  provenance capture stores **verbatim** — no allowlist, no truncation — because
  a body that justifies a specific clinical resource _is_ the provenance, and
  storing its `size` and `hash` with no `data` would defeat the point. What both
  share (`contentTypeOf`, `sha256Base64`) lives in `src/capture/`; what differs
  stays with its consumer. Don't unify them.
- **`producedResources` is the direction that survives multiple sources.** A
  resource derived from a list response _and_ a detail response is named by
  both of their traces via `context.related`. The resource's own back-pointer,
  `meta.source`, is a single FHIR `uri` and holds only the last writer — so
  anything that needs _every_ source of a resource must read it from the trace
  side. This also matters because the typed client expresses no reference-typed
  search parameter: there is no query for "every trace naming this resource",
  only the direct read `meta.source` gives you.
- **An empty `producedResources` writes no `context` at all.** A recorder
  produces nothing, and an empty `related` array would assert "this exchange
  produced no resources" where the truth is that nothing was decoding.
- **HAR export drops the provenance link.** HAR 1.2 has no field for "the
  resources this response produced", so an exported archive cannot carry it and
  a reader cannot recover it. `emit.test.ts` states this rather than inventing a
  place to put it.
- **`subject` stays absent on every trace resource.** Traces are engineering
  artifacts that happen to contain PHI; an unset `subject` keeps them out of
  `Patient/$everything` and out of clinical exports. They stay reachable by
  `category` search — `isWebTrace` is the one place that predicate is spelled out.
- **The `-core` layer talks to `globalThis.crypto.subtle`, not `node:crypto`.**
  That is what keeps the pure layer platform-free, and it is why the
  pseudonymizer is `Effect`-returning: Web Crypto has no synchronous digest.
- **`detectShape`'s classes are ordered most-specific-first and are disjoint by
  construction.** Loosening one regex can silently steal values from a later
  class. The example table in `shapes.test.ts` is the readable statement of what
  each class means; extend it when you touch a pattern.
- **`buildRedactionPolicy` then `redactExchange` is two steps for a reason.** The
  enum carve-out counts distinct values across the _whole session_, so it cannot
  be decided one exchange at a time. The policy also accumulates the
  value→pseudonym table — reuse one policy for a whole export, and never share
  one between exports.
- **The carve-out is shape-gated before it is counted, and the order is not
  cosmetic.** `isCodeToken` admits only letters/hyphens/underscores; a path with
  any other value is `notCode` and never reaches the threshold. A count-only
  rule let a single-patient session export its own email, birth date, and postal
  code — each takes exactly one distinct value at its path, so every threshold
  admitted it. **Low cardinality is what PHI looks like in a one-patient trace.**
  Widening `CODE_TOKEN` widens what leaves the device; `redact.test.ts` holds a
  property over the whole leaf corpus that fails if a verbatim path ever carries
  a digit, a space, or punctuation.
- **There are two verbatim rules, and the URI one is tested first.**
  `isCodeToken` is shape-gated _then counted_; `isNamespaceUri` is shape-gated
  and **never counted**, and answers to its own `namespaceUris` option. The
  order is not cosmetic: a URI is never a code token, so testing the code rule
  first would report every hidden `system` field as `notCode` and send the
  reviewer to a threshold that cannot bring it back. Exempting URIs from the
  count is deliberate — cardinality is a PHI signal only for values that
  describe a person, and eighteen distinct `extension[].url` values against a
  threshold of twelve is what the real capture held.
- **`isNamespaceUri` reads the value, never the field name.** `system` and
  `url` are promises the server makes; a `system` holding
  `http://host/Patient/8a3f2b1c` would export a record URL on the strength of
  its key. The gate is scheme + no query/fragment/credentials + code-token path
  segments, with an **allowlist** of version prefixes (`v`, `r`, `stu`, `dstu`,
  `fhir`) as the only digit-bearing exception. Widening that to "letters then
  digits" admits `w8`, `h1`, and `wqx0` — the opaque tenant segments a
  per-record URL is built from — so don't. `redact.test.ts` holds a property
  over the whole leaf corpus that fails if a verbatim path ever carries
  anything but a namespace URI.
- **The generated corpus carries namespace URIs on purpose.**
  `test-helpers.ts` puts them at `system` and `url` keys, kept out of
  `identifier` so it stays unambiguous which rule let a value through. Without
  them both carve-out properties pass without ever reaching their rule. For the
  same reason `redactWith` in `redact.test.ts` pins **both** switches off: the
  core defaults them on, and a property about pseudonymization would otherwise
  be reading values a carve-out let past.
- **A generated fake is re-derived until it is acceptable, not accepted on the
  first try.** A candidate must differ from its original, re-detect to the same
  shape, and be unused. That loop is what makes "no value survives itself" and
  "unequal inputs stay unequal" true by construction rather than by luck.
- **The HAR emitter never guesses.** `request.method` is `UNKNOWN`, unmeasured
  timings are `-1`, and a skipped body has a size and no text. Each carries a
  comment in the archive explaining itself. Filling one of these in with a
  plausible value would make the trace lie about what was observed.
- **The emitter does not redact.** `emitHar` on raw exchanges produces an archive
  containing everything the capture saw. Redaction is the caller's step.

## Testing

Property-based, per the project standard — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md).
`src/test-helpers.ts` holds the arbitraries: `Arbitrary.make(TraceExchange)`
would satisfy the schema while generating bodies that are not base64 and URLs
that are not URLs, which exercises nothing anything downstream actually does.

The five properties the privacy boundary rests on live in
`src/pseudonymizer/redact.test.ts`; the HAR emitter is validated against the
published `har-schema` (HAR 1.2) rather than a hand-copied transcription of it.

`ajv` is catalogued and listed in the **root** `devDependencies` so version 8
wins the hoist — eslint drags in ajv 6, and a root-level `vp lint` resolves bare
specifiers against the workspace root, not against this package.

## References

- [Redaction Explanation](./docs/Redaction%20Explanation.md) — the pseudonymizer's
  design and its stated limits.
- [slice AGENTS.md](../AGENTS.md) — why this slice exists at all.
- [slices/AGENTS.md](../../AGENTS.md) — the layering rules.
- [browser-sniffer AGENTS.md](../../browser-sniffer/AGENTS.md) — the upstream
  primitive whose wire schema this package's field types come from.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
