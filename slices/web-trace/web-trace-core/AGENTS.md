# AGENTS.md — slices/web-trace/web-trace-core

The pure layer of the web-trace slice. No DOM, no `fs`, no UI, no store — one
vocabulary, and the translations built on it.

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
  `systems.ts` holds the private systems and extension URLs.
- **`src/pseudonymizer/`** — the export boundary's redactor. `shapes.ts` detects
  what a value looks like and generates another value that looks the same;
  `hmac.ts` is the Web Crypto seam every fake is seeded from.
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
  go through `ObservedDuration`, which composes `Schema.JsonNumber` in front;
  don't unwrap it. Negatives are the same class of trap: `Duration.millis(-1)`
  is silently `Duration.zero`.
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

## Testing

Property-based, per the project standard — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md).
`src/test-helpers.ts` holds the arbitraries: `Arbitrary.make(TraceExchange)`
would satisfy the schema while generating bodies that are not base64 and URLs
that are not URLs, which exercises nothing anything downstream actually does.

## References

- [slice AGENTS.md](../AGENTS.md) — why this slice exists at all.
- [slices/AGENTS.md](../../AGENTS.md) — the layering rules.
- [browser-sniffer AGENTS.md](../../browser-sniffer/AGENTS.md) — the upstream
  primitive whose wire schema this package's field types come from.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
