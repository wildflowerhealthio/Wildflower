# AGENTS.md — slices/importer/importer-fundamentals

The **resource-agnostic, format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-response review
model, and the structural failure record the sinks report against. It is to the
importer slice what `collector-fundamentals` is to the collector slice — the
FHIR-agnostic layer a concrete binding (`har-importer-core`) sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell and a format's
React package drive.

## Shape

- `src/file-importer-descriptor.ts` — **`FileImporterDescriptor<TSettings,
TParsed, R>`**, "a file-format importer" as one value a closed registry lists.
  `format` (the registry key), `display`, `defaultSettings`, `sources` (the
  `SourceDescriptor<TParsed>[]` responses are recognized and decoded through, each
  grouping its kinds under a name + detail a review menu labels by — the flat pool
  routing needs is `SourceDescriptor.poolOf(sources)`, derived on demand rather
  than stored),
  `decode(fileText, settings) → Effect<Extraction.Input[], ParseError>` (requires
  nothing, `R = never` — a preview can never reach the write client), and
  `persist(resources, sourceRef) → Effect<PersistFailure[], never, R>` (the sink,
  the only carrier of `R`). It mirrors the collector slice's `CollectorDescriptor`
  but for the archive transport rather than the live one.
- `src/review.ts` — the **`Review`** namespace, the pure per-response,
  per-resource selection model built on `Extraction.recognize` / `parseWith`. A
  `Selection` is four axes: `enabledKinds` (whole-import kind toggles —
  disabling a kind removes it from every response's candidates), `overrides`
  (per-response pick, response id → kind **name**, for the rare cross-source
  overlap), `excludedResources` (per-resource opt-outs, keyed by
  `resourceKey(responseId, index)`), and `resourceOverrides` (per-resource
  inline edits, same keying — the reviewer's manually-edited resource replaces
  the parsed original at confirm). `pickFor` resolves one response (override
  if still enabled, else top-specificity enabled candidate, else none);
  `chosenCount` counts resolved picks without parsing; `preview` parses every
  chosen response's `parse` into a `PreviewedResponse` with stable per-resource
  keys (a parse failure is data, not a raised error); `chosenResources` folds a
  preview set through the exclusions and edit overrides into the confirm's
  write set — no re-parse at confirm, the reviewed (or edited) objects are what
  gets written. `Review.edit` / `Review.revert` mint and drop the per-resource
  edit; the model is resource-type-agnostic (the override slot is `unknown`)
  and it is the seam that mints an edit — a format's React affordance,
  schema-validated — that enforces its shape. The old `chosen` helper
  (parse-and-fold in one shot) still exists on top of `preview` for callers
  that don't need a preview. `recognize` is re-exported so a format's React
  package reads recognition through this package.
- `src/persist-failure.ts` — **`PersistFailure`**, the structural echo of a
  write sink's own failure record (`{ failed: { label, id }, cause }`). Declared
  here — this package sits below the concrete sinks and cannot name them — and
  checked **structurally** at each binding's seam, mirroring how
  `collector-fundamentals` declares its `PersistFailure` against `fhir-r4`'s
  `ResourceWriteFailure`.

## Layering

Depends only on `http-extraction-fundamentals` (`Extraction`, `HttpResponseKind`)
and `effect`. Names no archive format (`har-importer-core` supplies `decode`), no
resource type (`TParsed`, bound to `FhirResource` in `har-importer-core`), and
no UI framework (the interactive `ReviewBody` a format's React package renders is
a view over these transitions). Never imports a `*-importer-core`, a
`*-importer-react`, `slices/collector`, or `fhir-r4`.

## Guardrails

- **Recognition is per-response.** A review is a set of choices _per response_,
  not one winning source for a whole archive. The default pick for a response is
  the top-specificity candidate among the enabled kinds — exactly what routing
  would choose — so an untouched review writes what the archive-runner
  reference model (`runExtraction`, in `http-extraction-fundamentals`'
  test-helpers) would have.
- **Preview-then-persist.** `Review.preview` parses each chosen response so the
  reviewer sees the actual resources; the confirm writes `Review.chosenResources`
  — the same objects, filtered by the exclusions — with no re-parse. A response
  with no chosen pick is never parsed, and `Extraction.parseWith` folds every
  non-resource outcome to data, so `preview` is total and infallible.
- **Overrides key by name, not object; exclusions key by `resourceKey`.**
  Selection state must be serializable, so `overrides` maps a response id to a
  kind **name** and `excludedResources` holds string keys; the candidate objects
  that carry the kind for execution are re-derived from recognition each render,
  and the reviewed resource objects survive re-render because `preview` runs
  under the shell's memoised inputs.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that implements this contract.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that lists
  descriptors and drives the `Review` transitions.
- [slices/http-extraction/AGENTS.md](../../http-extraction/AGENTS.md) — the
  `Extraction` vocabulary this package is written against.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
