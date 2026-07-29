# AGENTS.md — slices/collector/web-trace-collector

The **web-trace collector**: point it at a URL, browse the portal by hand, close
the window, and every XHR/fetch those pages fired is on device as a FHIR
`DocumentReference`. It exists to produce the input for designing a _real_
collector against that portal — a recording a collector author (or an agent) can
read to learn what the portal's endpoints actually are.

It is a **development-purposes** collector. It imports no clinical data and
synthesizes no clinical resource; what it writes is an engineering artifact that
happens to contain PHI, which is why traces carry no `subject` and are reachable
only by `category`.

## Shape

An ordinary `*-client-collector`, mirroring `rexall-be-well-collector`'s layout:

- `src/config.ts` — `InstanceConfig`
  (`{ _tag: 'web-trace', rootUrl, sessionLabel?, bodyContentTypes, maxBodyBytes }`)
  with fast-check arbitraries, `defaultConfig`, the hand-driven `scrapingPlan`,
  and the `WebTraceCollectorDescriptor`.
- `src/body-policy.ts` — the capture-time body policy: content-type extraction,
  allowlist token matching, the size cap, and the SHA-256 every body carries.
- `src/entities/raw-exchange-entity.ts` — the catch-all entity. One
  `DocumentReference` per exchange, encoded by `web-trace-core`'s codec.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- `src/web-trace-config-form.tsx` (+ `.module.css`) — the `ConfigFormProps` form
  `collector-react` registers.

## Invariants

These four are the point of the collector. Changing any of them changes what a
recording _means_, not just how it is implemented.

### 1. No URL filtering, ever

`isFoundAt` returns `true` unconditionally. The allowlist governs **bodies**,
never whether an exchange is recorded — every response the sniffer reports
becomes a `DocumentReference`, and a declined body still records its `size`,
`hash`, and the reason it was declined.

**The catch-all matters twice.** The obvious half is coverage: a recording that
filtered by URL would decide in advance what a collector author is allowed to
discover. The half that is easy to miss is that `CollectorBridgeMessageHandler`
fires a `CancelSnifferRequest` at any response no entity claims — so a narrower
predicate would not merely skip those exchanges, it would **abort the requests
the user's own browsing depends on** and break the page in front of them.

### 2. Redaction never happens on the write path

What is stored is what was seen. Redaction is an export-time concern (the viewer
app), and that asymmetry is what lets a better redactor be applied retroactively
to sessions already recorded. Nothing under `src/` may import
`web-trace-core/pseudonymizer`.

### 3. `parse` and `persistResources` never fail the run

One unparseable exchange must not lose a session. `parse` fails only for the one
exchange that hit the problem — the tracker records a failed sniff and the run
keeps draining — and `persistResources` has a `never` error channel, returning
unwritable resources as `PersistFailure` data.

A body that is **not UTF-8 decodable is stored base64 with its content type, not
dropped**. This is why the policy reads `RemoteResponse.bytes()` and never
`text()`: `text()` replaces undecodable bytes with U+FFFD, and a re-encode of
that string is not the body that arrived.

### 4. A trace is not a network log

The sniffer shims `fetch` and `XMLHttpRequest` only. Subresource loads — images,
stylesheets, scripts, fonts, media, WebSocket and EventSource traffic, and
navigations themselves — are **invisible** to it and therefore absent from a
trace. A recording is the portal's _API conversation_, not its network activity;
anything reading a trace as "everything the page did" is reading it wrong.

There is also no request side at all: no method, no request headers, no request
body (see `browser-sniffer`'s known limitation). A GET and a POST to the same URL
are indistinguishable in a trace, and POST payloads — often the most valuable
artifact for designing a collector against a search API — are not captured.

## Traps

- **The encoding lives in `web-trace-core` and is imported, never re-derived.**
  A second copy drifts, and already-recorded sessions stop decoding.
  `toDocumentReference` is the only way a trace resource is built here.
- **This plan is _not_ wrapped in `adoptSourceIdentity`, and must not be.** A
  trace's id already comes from the shared derivation, applied once at
  `traceResourceId`; adopting it on top would hash a hash. The combinator is for
  a collector that _imports_ resources another system identified — see the
  [Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).
- **`makeScrapingPlan` is `(config, runId) => plan`, deterministic given its
  inputs — the framework mints the run id.** The session id is
  `sessionIdFor(config, runId)` (the optional label prefixed onto the
  framework's per-dispatch uuid), because `(sessionId, requestId)` is what the
  resource id is derived from: a session id derived from the config alone would
  make a second recording of the same remote silently upsert over the first. One dispatch is
  one run is one recording, enforced by `CollectorDescriptor.make` sealing the
  plan and its run id together. The recording entity still closes over the
  session id, so two _dispatches_ produce structurally unequal plans — which is
  why `collector-registry`'s union-wide dispatch test compares a plan
  _identity projection_ rather than deep equality.
- **`sessionLabel` is a label, not an identity.** It only prefixes the run id
  for legibility. Deriving the id from it alone collides on exactly the case a
  user is most likely to hit — recording the same flow twice.
- **`[EnsureWindowVisible, AwaitUserDismiss]` is the whole run model.** An empty
  `stepSequence` would complete the instant the first `PageLoaded` settled, before
  the user had clicked anything. `EnsureWindowVisible` puts the window on screen
  (best-effort — nothing acknowledges it); `AwaitUserDismiss` parks until the user
  closes it, then **drains** rather than completing, so requests still in flight
  at that moment are finished and recorded.
- **`idleTimeout` must stay above the hold's own `timeout`.** The sync runner's
  silent-host guard does not know the hold is waiting on a person and would
  abandon the run long before the user acts. `IDLE_TIMEOUT` (3 h) sits above
  `USER_DISMISS_TIMEOUT` (2 h), and `config.test.ts` pins the ordering.
- **The allowlist matches media-type _tokens_, not full media types.** An entry
  is matched against the type, the subtype, and both halves of a structured
  suffix, so `json` covers `application/fhir+json` — which is the single most
  interesting body in a health-portal trace and the one nobody thinks to add by
  hand. See the token table in `body-policy.ts`. A consequence worth knowing:
  the default `text` entry means "any `text/*`", including `text/javascript`;
  `maxBodyBytes` is what keeps a bundle from dominating a recording.
- **The content-type check runs before the size check.** A body that is both
  off-list and over-cap reports the allowlist as its reason — the one the user
  would change to get it back.
- **Every body carries a SHA-256, stored or skipped**, so a skipped body is still
  evidence. That digest is Web Crypto, which is `Promise`-returning, which is why
  the body policy is `Effect`-shaped and why `parse` can fail at all.
- **`RemoteResponse` carries `id` and `startedAt` for this collector's sake.**
  Other entities decode a payload and need neither; a recorder needs the sniffer's
  correlation id (for the resource id) and the observed response-start instant
  (so a trace does not claim the settle was the start). `timings.receive` is
  measured from `startedAt` to the parse; `timings.wait` stays `null` because
  nothing observes the request side.
- **`type="url"` on the start-URL field means the browser catches a malformed
  URL before the form's own decode runs.** The schema's job is the _scheme_
  check (`http`/`https` only); a form test that wants to exercise the schema has
  to use a well-formed URL with the wrong scheme.

## Registration

Two static edits, per the descriptor seam:

- `collector-registry/src/registry.ts` — appended to the `descriptors` tuple.
- `collector-react/src/forms/config-form.tsx` — `'web-trace': WebTraceConfigForm`
  in the closed `configForms` map.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the
  codec, and the traps in the encoding this collector writes.
- [web-trace slice AGENTS.md](../../web-trace/AGENTS.md) — why the slice exists
  and the store-raw/anonymize-at-export asymmetry.
- [slices/collector/AGENTS.md](../AGENTS.md) — the `AwaitUserDismiss` /
  `EnsureWindowVisible` / `idleTimeout` traps in full.
- [browser-sniffer AGENTS.md](../../browser-sniffer/AGENTS.md) — the sniffer whose
  shim scope invariant 4 describes.
