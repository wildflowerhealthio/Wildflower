# AGENTS.md — slices/http-extraction/http-extraction-fundamentals

The vocabulary of extracting entities from HTTP traffic: everything needed to
reason about "an HTTP source" — a thing that recognizes traffic and decodes it
into resources — without any reference to how the traffic was obtained. The
collector runs this vocabulary live; the HAR importer runs it over archives;
both build on this package, never the reverse.

## Namespaces

One namespace per module, in the `effect` style: the file is the noun, the
principal type shares the namespace's name (`Source.Source`), and functions
read in the namespace's context (`Extraction.run`, not `runExtraction`). All
six are exported from the **flat root entry**:
`import { EntityDefinition, Extraction, Source } from 'http-extraction-fundamentals'`.

- **`EntityDefinition`** (`src/entity-definition.ts`) — the recipe for
  recognizing and decoding one response shape: `name` / `isFoundAt` / `parse`.
  `parse` takes an `HttpResponse` and returns
  `Effect<readonly TResources[], ParseError>` — a pure decode, never
  navigation. `make` shallow-clones and deep-freezes.
- **`UrlMatch`** (`src/url-match.ts`) — the declarative URL-recognition regex
  builder `isFoundAt` predicates are made from (`make` / `literal` / `id`,
  `pathEnd` vs `mustHaveQuery` boundaries).
- **`HttpResponse`** (`src/http-response.ts`) — what a `parse` sees: `id` /
  `url` / `status` / `statusText` / `headers` (`Headers`) / `startedAt` /
  `bytes()` / `text()`. An interface, not a class: `make` builds one over
  bytes already in hand (an `Init`, the extraction path), and
  `collector-fundamentals`' `RemoteResponse` implements it over streamed
  chunks (the live path) — that `implements` clause is the compile-time pin
  that both paths hand entities the same surface.
- **`Extraction`** (`src/extraction.ts`) — run archived responses through a
  source's entities. `Extraction.run(entities, inputs)` folds each
  `Extraction.Input` (an `HttpResponse.Init` + `bodyAbsent`) through
  first-`isFoundAt`-match-wins routing into an `Extraction.Extraction`: the
  four-way accounting of `batches` / `unmatched` / `parseFailures` /
  `bodyAbsent`, every input in exactly one bucket, in input order.
  Infallible — failures are data, not errors. It never persists.
- **`Recognizer`** (`src/recognizer.ts`) — how a source claims a response set
  with no user configuration (`name` / `specificity` / `claims`);
  `Recognizer.resolve` picks the most specific claimant. Specificity
  convention: portal-specific > protocol-generic > catch-all.
- **`Source`** (`src/source.ts`) — an HTTP source as one first-class value:
  `Source.Source<TResources>` extends `Recognizer.Recognizer` with `tag`,
  `entities` (a plain readonly array), and `rootOf(url)`. Concrete source
  packages assemble one (`fhir-r4-source`'s `fhirR4Source`); each consumer
  keeps its own closed list of them.

`http-extraction-fundamentals/test-helpers` is the one sub-entry:
`makeHttpResponse`, `makeExtractionInput`, the `SimpleEntity` /
`AnotherEntity` sample entities, and the `echoEntity` provenance-asserting
builders shared with `collector-fundamentals`' parity test.

## Layering

- **This package imports from no slice.** Its dependencies are exactly
  `effect` and `kitchen-sink`. In particular it must never import
  `collector-fundamentals` (which depends on this package), any
  `*-client-collector`, a `*-source` package, or anything in
  `slices/importer`.
- The live-vs-archive parity pin — that `Extraction.run` and the collector's
  `SnifferResponseTracker` route and decode identically — lives in
  `collector-fundamentals/src/handler/extraction-parity.test.ts`, the one
  package that can see both halves. A test here that wants `RemoteResponse`
  is in the wrong package.
- Collector-only concerns extend rather than live here:
  `CollectorEntityDefinition` (collector-fundamentals) adds the optional
  `followUpSteps` crawl seam on top of `EntityDefinition`, and `Extraction`
  knows nothing about it — extraction navigates nothing.

## Traps

- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`). A missing entry silently ships no dist for
  that subpath and only fails downstream on a fresh `vp run pack`.
- **`Extraction.Input.bodyAbsent` is not an empty body.** An archive can
  record an exchange while omitting its content; `run` reports that as its
  own bucket and never calls `parse` — decoding it as an empty payload would
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
