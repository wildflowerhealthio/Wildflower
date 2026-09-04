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
  The `har-archive` codec (a whole uploaded `.har` file as one attachment)
  moved to `har-importer-core/archive` in M1 of #578; the shared systems
  constants it still reaches for (`HAR_ARCHIVE_CODE`, `WEB_TRACE_CODE_SYSTEM`,
  `WEB_TRACE_RAW_CODE`, `WEB_TRACE_REDACTION_SYSTEM`) stay here — a trace and
  an archive sit on the same axis under different codes, and `isWebTrace` and
  `isHarArchive` never both hold.
- **`src/capture/`** — the capture-side primitives both consumers share:
  the content-type rule, the SHA-256 every body carries, and `storeBodyVerbatim`.
  Policy is _not_ here — see the trap below.
- **`src/provenance/`** — the receipt for a resource a collector derived from a
  response: `captureProvenance` builds the trace and links it both ways;
  `toExchangeFields` is the one statement of the response → exchange field
  mapping (the recorder's entity spreads it too); `makeFhirProvenanceCapture`
  is the hook factory a production collector states as its plan's
  `captureProvenance`. `CapturedResponse` names the readable surface of
  `collector-fundamentals`' `CollectorHttpResponse` _structurally_ — this package
  sits below the collector slice and must not import it, so the boundary is a
  shape, not a dependency.
- **`src/pseudonymizer/`** — the export boundary's redactor. `shapes.ts` detects
  what a value looks like and generates another value that looks the same,
  `leaves.ts` decides what counts as a leaf, `redact.ts` is the two-step
  policy/rewrite engine, and `hmac.ts` is the Web Crypto seam.
- **`src/har/` — moved to `har-importer-core/har`** in M1 of #578. The
  format definition and the `HttpArchive` projection now live with the
  importer slice's HAR binding. `emitHar` still takes `TraceExchange` (its one
  caller, `web-trace-react`'s export flow, still speaks that vocabulary until
  R2 dissolves it), and reaches back here for the type.
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
- **`(sessionId, requestId)` is the identity of an exchange; the resource id is
  its hash.** The sniffer already assigns a correlation id per request, so ids
  are deterministic without threading a counter through a parse, retried writes
  are idempotent upserts, and two sessions cannot collide. What the pair is
  _rendered_ as is `fhir-r4`'s `localResourceId` — the one derivation every
  stored resource is keyed under — so a reader goes through the two `Identifier`
  entries, never through the id. `traceResourceId` is the **single** site that
  mints it; a trace must never also be run through `adoptUnderRecognizedRoot`,
  which would hash the hash. A session label is an arbitrary string, so spelling the
  id `{sessionId}-{requestId}` verbatim could mint an id outside FHIR's grammar;
  going through the derivation makes that unrepresentable. The pair is folded
  with `joinIdComponents`, the length-prefixed encoding `localResourceId` uses on
  its own components — a `-` join would make `('s-req', '77')` and
  `('s', 'req-77')` the same exchange.
- **`traceResourceId` is two hash lanes, not a concatenation — keep it out of
  render paths.** It belongs at a write or a decode. The viewer keys its rows and
  its selection with `web-trace-react`'s `exchangeKey` (the same encoded pair,
  unhashed) because a React `key` needs identity within one list, not the
  resource id. Calling this per row per render cost ~24 ms per keystroke on a
  thousand-exchange session, against ~0.04 ms for the pair.
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
  The same holds for a HAR archive, for the same reason.
- **Traces and HAR archives share a code system and nothing else, and the
  disjointness is load-bearing.** A trace is one exchange this system captured;
  a `har-archive` document is an opaque `.har` file someone uploaded. They sit
  on the same `category` axis under different codes, so `isWebTrace` and
  `isHarArchive` never both hold and each decoder rejects the other's documents
  rather than reading nonsense out of them — the viewer must never list an
  archive, and the importer's server list must never list a trace. A property
  over both generated corpora fails if that ever stops being true.
- **The archive codec stores bytes, never text, and does not parse HAR.** A
  `HarArchive.bytes` is base64 of the file exactly as uploaded, so a truncated or
  mis-encoded upload is preserved rather than mangled and the attachment `hash`
  means something. Reading the contents is `src/har/`'s job — `HarFromJson` and
  the `HttpArchive.LogFromHarJson` projection — and it is where a malformed upload
  is meant to fail, not here.
- **Every upload is a fresh document.** The id is a uuid the caller mints, not a
  derivation over the bytes — the same file twice is two documents on purpose.
  Dedupe stays _detectable_ through `hash`/`size` without being forced, which is
  the opposite of a trace, whose id **is** its `(sessionId, requestId)` identity
  so a retried write upserts.
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
  its key. A value qualifies by **trusted host or by shape**. The shape gate is
  scheme + no query/fragment/credentials + code-token path segments, with an
  **allowlist** of version prefixes (`v`, `r`, `stu`, `dstu`, `fhir`) as the
  only digit-bearing exception. Widening that to "letters then digits" admits
  `w8`, `h1`, and `wqx0` — the opaque tenant segments a per-record URL is built
  from — so don't. `redact.test.ts` holds a property over the whole leaf corpus
  that fails if a verbatim path ever carries anything but a namespace URI.
- **A `TERMINOLOGY_HOSTS` entry skips _every_ structural check, query string
  included.** That is what lets `.../CodeSystem/v2-0203` through, where the
  shape rules cannot tell an HL7 table number from a record id. Matching is
  **exact on `hostname`** — not a suffix test, or `hl7.org.example.com` would
  be trusted, and not on `host`, or a port would defeat an entry. The list
  mixes standards bodies (which cannot serve a record URL) with portal schema
  hosts (which are trusted because someone read a capture from that portal);
  only add one of the second kind after looking at real traffic. A subdomain
  needs its own entry, which is why `schema.` and `schemas.carebook.com` are
  both listed.
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
- **The archive format is a schema, not a reader and a writer.** `Har` is one
  definition read in both directions, like the codec: `Schema.decode` reads an
  archive, `Schema.encode` writes one, `HarFromJson` does both from a file's
  text, and every failure is a `ParseError`. `emitHar` builds the **decoded**
  form — instants as `DateTime`, headers as pairs, bodies as a `HarBody` union
  — so anything writing a file has to encode first. `web-trace-react`'s
  `harBlob` is the one place that matters; stringifying the decoded form
  directly writes a file no HAR reader accepts.
- **Decoding is forgiving, encoding is canonical.** Fields the spec requires but
  an import has no opinion about (`httpVersion`, `cookies`, `headersSize`,
  `cache`, `timings`) default rather than fail, and unknown keys are ignored —
  which is what lets a Chrome DevTools export with its `pages`, `postData` and
  `_`-prefixed extras decode at all. `response.status` is deliberately looser
  than the sniffer's `[0, 1000]` for the same reason. Encoding writes every
  field the spec requires, and a body always goes out base64 — a text body read
  from a foreign archive comes back base64, same bytes.
- **`HttpArchive.Entry` is a projection, so encoding it is canonical rather
  than verbatim.** It carries the response half and the body bytes, so a re-encoded
  archive states HAR's own "not observed" values for the request side and the
  timings, with a comment saying they were not carried through the import. The
  properties that hold are `decode(encode(x)) == x` and `read(write(read(f)))
== read(f)` — not `encode(decode(f)) == f`, which no projection can give.
- **`bodyAbsent` is a distinct fact from an empty body.** Our own emitter writes
  a `size` with no `text` for a policy-skipped body and DevTools does the same
  for content the browser discarded; both parse to empty bytes _plus_ the flag.
  A consumer that reads `body.length === 0` as "the response was empty" is
  reading a gap in the archive as data.
- **A base64 body that will not decode degrades to `bodyAbsent`; it does not fail
  the archive.** `encoding: base64` is spec-required to mean `text` is RFC 4648
  base64, and it does for Chrome and for our own exports. Firefox breaks it: it
  tags _every_ response `encoding: base64`, but for a binary body it only kept as
  a lossy UTF-8 string (a chrome-fetched favicon) it writes that mangled string —
  NUL bytes and U+FFFD, not base64 — under the label. Those bytes are already
  destroyed at export, so `readBody` reads an undecodable base64 body as absent
  rather than rejecting the whole file over one unreadable favicon and losing the
  clinical entries with it. This is the **only** malformation that degrades:
  invalid JSON, JSON that is not a HAR, and a missing `status` still fail the
  parse. The decode of `HttpArchive.LogFromHarJson` therefore cannot fail once `Har`
  has parsed, which is why it is a plain `ParseResult.succeed`.
- **`HttpArchive.Entry` is a shape, not a dependency — same trick as
  `CapturedResponse`.** Its field names (`id`, `url`, `status`, `statusText`,
  `headers`, `startedAt`) are the ones a captured response carries, so a replay
  runner can consume an imported exchange and a live capture through one type
  without this package importing the collector slice. Renaming a field here
  breaks that alignment silently — the compiler has nothing to check it against.
  Its `mimeType` on the way back out is re-derived from its own headers with
  `contentTypeOf`, the same rule the capture side uses.
- **A HAR gives an exchange no identity, so a read synthesizes one.**
  `har-entry-<index>` at the entry's position in `log.entries`: the format has
  no request id, and two entries can be identical in every field a parse reads.
  Entries stay in **file** order — the emitter sorts by start instant, a parse
  does not re-sort, and a DevTools export is not sorted at all.

## Testing

Property-based, per the project standard — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md).
`src/test-helpers.ts` holds the arbitraries: `Arbitrary.make(TraceExchange)`
would satisfy the schema while generating bodies that are not base64 and URLs
that are not URLs, which exercises nothing anything downstream actually does.

The five properties the privacy boundary rests on live in
`src/pseudonymizer/redact.test.ts`; the HAR emitter is validated against the
published `har-schema` (HAR 1.2) rather than a hand-copied transcription of it.
The reading direction is held to the emitter — a property in
`src/har/http-archive.test.ts` round-trips a generated session through
`emitHar` and back — and to a committed synthetic DevTools export for the half
our own archives never exercise. `emit.test.ts` validates the **encoded**
archive against `har-schema`, which is the only side the spec describes.

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
