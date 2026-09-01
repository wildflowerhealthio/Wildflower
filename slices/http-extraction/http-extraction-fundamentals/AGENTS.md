# AGENTS.md — slices/http-extraction/http-extraction-fundamentals

The vocabulary of extracting entities from HTTP traffic: everything needed to
reason about "an HTTP source" — a thing that recognizes traffic and decodes it
into resources — without any reference to how the traffic was obtained. The
collector runs this vocabulary live; the HAR importer runs it over archives;
both build on this package, never the reverse.

## Namespaces

One namespace per module, in the `effect` style: the file is the noun, the
principal type shares the namespace's name (`HttpResponseKind.HttpResponseKind`),
and functions read in the namespace's context (`Extraction.routeTo`, not
`routeExtractionTo`). All are exported from the **flat root entry**:
`import { HttpResponseKind, Extraction, Specificity, UrlMatch } from 'http-extraction-fundamentals'`.

- **`HttpResponseKind`** (`src/http-response-kind.ts`) — the recipe for
  recognizing and decoding one response shape: `name` / `tryRecognize` /
  `parse`. `tryRecognize(url)` returns `Option<RecognizedUrlData>` — `None` when
  the kind does not claim the URL, `Some { specificity, source? }` when it does,
  where each kind constructs its **own** identity: recognition, root, and
  confidence are one read. `source` (structurally `fhir-r4/identity`'s
  `SourceIdentity`, on purpose) is the namespace this response's resources key
  under, and is **absent** for a kind that recognizes but mints no identity (a
  recorder records, it does not import). `parse` takes an `HttpResponse` and
  returns `Effect<readonly TParsed[], ParseError>` — a pure decode, never
  navigation. `make` shallow-clones and deep-freezes.
- **`UrlMatch`** (`src/url-match.ts`) — the declarative URL-recognition regex
  builder a kind's `tryRecognize` is made from (`make` / `literal` / `id`,
  `pathEnd` vs `mustHaveQuery` boundaries). A `make` call returns the
  `UrlMatcher` itself — the bare `(url) => Option<root>` function: recognition
  **and** root are one read of one `^`-anchored, scheme-required pattern (group 1
  captures `https?://<authority><base path>`), so they can never disagree. A
  non-`http(s)` or scheme-less URL is `None` (a deliberate tightening — a root
  must be a URL a `SourceIdentity` can key under).
- **`HttpResponse`** (`src/http-response.ts`) — what a `parse` sees: `id` /
  `url` / `status` / `statusText` / `headers` (`Headers`) / `startedAt` /
  `bytes()` / `text()`. An interface, not a class: `make` builds one over
  bytes already in hand (a `Data`, the extraction path), and
  `collector-fundamentals`' `CollectorHttpResponse` implements it over streamed
  chunks (the live path) — that `implements` clause is the compile-time pin
  that both paths hand entities the same surface.
- **`Extraction`** (`src/extraction.ts`) — recognize and decode archived
  responses. `routeTo(pool, url)` picks the one claiming kind of highest
  specificity (ties → list order); `recognize(pool, responses)` keeps **every**
  claiming kind per response, ranked (the input an interactive picker needs);
  `parseWith(kind, response)` decodes one response, folding every outcome —
  resources, `parseError`, `bodyAbsent` — to data, over `Extraction.Input`s (an
  `HttpResponse.Data` + `bodyAbsent`). Infallible — failures are data, not
  errors. It never persists. The batch runner that used to live here
  (`runExtraction`, the four-way `batches` / `unmatched` / `parseFailures` /
  `bodyAbsent` accounting) was demoted to `test-helpers` when the interactive
  review replaced it in production — it survives as the executable reference
  model the parity and fixture suites pin against.
- **`Specificity`** (`src/specificity.ts`) — the exported cross-source tier
  constants a kind's `tryRecognize` draws its `specificity` from and routing
  ranks by, **highest wins**: `PORTAL` (100, a named patient portal) > `PROTOCOL`
  (50, any FHIR R4 server) > `CATCH_ALL` (0, a recorder). A plain ordered
  convention, not an enum this package polices — the ranking the deleted `Source`
  value's doc comment used to hold. Room left between tiers so a new source slots
  in without renumbering.

`http-extraction-fundamentals/test-helpers` is the one sub-entry:
`makeHttpResponse`, `makeExtractionInput`, the `SimpleResponseKind` /
`AnotherResponseKind` sample response kinds, the `echoResponseKind` provenance-asserting
builders shared with `collector-fundamentals`' parity test, and `runExtraction`
(`src/run-extraction.ts`) — the archive-runner reference model returning the
four-way `ExtractionResult` accounting.

## Layering

- **This package imports from no slice.** Its dependencies are exactly
  `effect` and `kitchen-sink`. In particular it must never import
  `collector-fundamentals` (which depends on this package), any
  `*-client-collector`, a `*-source` package, or anything in
  `slices/importer`.
- The live-vs-archive parity pin — that `runExtraction` and the collector's
  `SnifferResponseTracker` route and decode identically — lives in
  `collector-fundamentals/src/handler/extraction-parity.test.ts`, the one
  package that can see both halves. A test here that wants `CollectorHttpResponse`
  is in the wrong package.
- Collector-only concerns extend rather than live here:
  `CollectorHttpResponseKind` (collector-fundamentals) adds the optional
  `followUpSteps` crawl seam on top of `HttpResponseKind`, and `Extraction`
  knows nothing about it — extraction navigates nothing.

## Traps

- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`). A missing entry silently ships no dist for
  that subpath and only fails downstream on a fresh `vp run pack`.
- **`Extraction.Input.bodyAbsent` is not an empty body.** An archive can
  record an exchange while omitting its content; `parseWith` folds that to its
  own outcome and never calls `parse` — decoding it as an empty payload would
  manufacture a parse failure for a response that was never in evidence.
- **`bytes()` returns a fresh copy each call** (both `HttpResponse.make`
  and the live implementation) so a caller cannot mutate the body out from
  under a later reader.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  anchors, and why there is no `-core`.
- [slices/collector/AGENTS.md](../../collector/AGENTS.md) — the live consumer.
- [slices/importer/AGENTS.md](../../importer/AGENTS.md) — the archive-driven
  consumer.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
