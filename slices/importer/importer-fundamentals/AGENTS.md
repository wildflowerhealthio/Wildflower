# AGENTS.md — slices/importer/importer-fundamentals

The **resource-agnostic, format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-resource review
model, and the structural failure record the sinks report against. It is to the
importer slice what `collector-fundamentals` is to the collector slice — the
layer a concrete binding (`har-importer-core`, `lifelabs-pdf-importer-core`)
sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell drives.

## Shape

- `src/file-importer-descriptor.ts` — **`FileImporterDescriptor<TSettings,
TParsed, R>`**, "a file-format importer" as one value a closed registry lists:
  `format` (the registry key), `display`, `accept` (the picker `accept`
  tokens — a hint to the OS dialog, never the decision, joined across every
  registered format by **`acceptFor`**), `detect` (cheap syntactic
  identification; **`identify`** finds the first claiming descriptor),
  `defaultSettings`, `decode(fileBytes, settings) → Effect<DecodedFile,
ParseError>` (requires nothing — a preview can never reach the write
  client), `uploadSource` (the source-archive `DocumentReference` upload a
  confirm runs for a local pick), and `persist(resources, sourceRef) →
Effect<PersistFailure[], never, R>` (the sink, the only carrier of `R`).
  The decode's result is a **`DecodedFile<TParsed>`**: titled
  **`LabeledSection`**s of **`LabeledResource`**s (stable `key`, one-line
  `title`, the parsed `resource`) plus file-level diagnostic note strings for
  what did not become a resource. **`sectionResources`** flattens the sections
  in order — the list the review transitions and the confirm fold over.
  **`SettingsPickerProps<TSettings>`** (the `{ settings, onChange }` contract
  every format's settings picker renders against) also lives here, below
  every format's React package. Settings are pre-decode input: a change
  re-decodes the file, so resource keys must be stable across settings
  changes where the underlying resource is unchanged.
- `src/review.ts` — the **`Review`** namespace, the pure per-resource
  selection model. A `Selection<TParsed>` is two axes: `excludedResources`
  (per-resource opt-outs, keyed by `LabeledResource.key`) and
  `resourceOverrides` (per-resource inline edits, same keying — the
  reviewer's edited resource replaces the decoded original at confirm).
  `initial` / `toggleResource` / `setResourcesIncluded` (the batch form of
  `toggleResource`, so the shell can opt a whole section in or out at once) /
  `edit` / `revert` are the transitions;
  `isResourceIncluded` / `isResourceEdited` / `editedResource` the reads;
  `chosenResources` folds a flat labeled list through the exclusions and
  edit overrides into the confirm's write set — no re-parse at confirm, the
  reviewed (or edited) objects are what gets written; `includedCount` /
  `excludedCount` drive the shell's tallies. Orphaned selection entries
  (keys a re-decode no longer produces) are inert — sets and maps of keys,
  nothing dangling.
- `src/persist-failure.ts` — **`PersistFailure`**, the structural echo of a
  write sink's own failure record (`{ failed: { label, id }, cause }`). Declared
  here — this package sits below the concrete sinks and cannot name them — and
  checked **structurally** at each binding's seam, mirroring how
  `collector-fundamentals` declares its `PersistFailure` against `fhir-r4`'s
  `ResourceWriteFailure`.

## Layering

Depends only on `effect` (and `kitchen-sink` in tests). Names no archive
format (each binding supplies `decode`), no resource type (`TParsed`, bound to
`FhirResource` in the bindings), no HTTP vocabulary (the HAR binding's
recognition machinery lives in `har-importer-core`), and no UI framework.
Never imports a `*-importer-core`, a `*-importer-react`, `slices/collector`,
`slices/http-extraction`, or `fhir-r4`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes `Review.chosenResources` —
  the same objects, filtered by the exclusions, with edits substituted — with
  no re-parse. This split is the whole point; do not collapse it.
- **Sections and notes are the whole review surface.** A format with routing
  decisions (HAR's kind toggles) expresses them as _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **Selection keys by `LabeledResource.key`.** Selection state must be
  serializable and survive a settings re-decode, so both axes hold string
  keys; a key that disappears simply stops applying.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that implements this contract.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that lists
  descriptors and drives the `Review` transitions.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
