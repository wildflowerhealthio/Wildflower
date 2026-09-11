# Adding a File-Format Importer How-To

The end-to-end checklist for adding a new file format the importer can turn into
FHIR resources — a `.csv`, a `.json` export, a DICOM archive. For _why_ the slice
is layered the way it is, read [slices/importer/AGENTS.md](../AGENTS.md) first;
this doc is the recipe. HAR (`har-importer-core` + `har-importer-react`) is the
worked example throughout.

A format is registered with exactly **one static edit** — its
`FormatRegistration` into `importer-react`'s closed `formatRegistry` — because
the slice has no runtime registry. Everything before that edit lives in a new
`*-importer-core` binding (and its `*-importer-react` UI) that implements the
`importer-fundamentals` contract.

## What you're building

The importer slice mirrors the collector slice: a resource-agnostic
**fundamentals** layer (`importer-fundamentals`), a per-format **binding** (core +
React), and a **shell** (`importer-react`). A new format adds the binding and one
registry line; it touches neither `importer-fundamentals` nor `http-extraction`.

| Piece           | Where                                          | Contract                                                     |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Decode dialect  | a pure dialect package (below both transports) | the format's document → structural responses / resources     |
| Response kinds  | `slices/http-extraction/*-source/`             | `HttpResponseKind` — recognize + parse (only if HTTP-shaped) |
| Descriptor      | `*-importer-core/src/*-importer.ts`            | `FileImporterDescriptor` — `decode` / `pool` / `persist`     |
| Settings        | `*-importer-core/src/*-settings.ts`            | `TSettings` + `defaultSettings` (an empty record if none)    |
| Persist sink    | `*-importer-core/src/persist-*.ts`             | import `fhir-r4`'s `persistResources` — don't write your own |
| Settings picker | `*-importer-react/src/settings-picker.tsx`     | `SettingsPickerProps<TSettings>`                             |
| Review body     | `*-importer-react/src/review-body.tsx`         | `ReviewBodyProps` — a view over `Review`                     |
| Registry entry  | `importer-react/src/registry.ts`               | append to `formatRegistry`                                   |

## When a format is _not_ HTTP traffic

HAR is the odd one out: its contents _are_ HTTP traffic, so its pool is a list of
`HttpResponseKind`s from `slices/http-extraction`, and `decode` restates each
archived exchange as an `Extraction.Input`. A format whose contents are a
**document** (a CSV, a DICOM file) does not have HTTP responses. Its decode
belongs in a pure dialect package — the way rexall's carebook dialect and
`web-trace-core`'s codec work — and its `pool` is a list of `HttpResponseKind`s
whose `parse` wraps that same dialect, with a `tryRecognize` that keys the
document's rows/records under a minted source identity. The dialect sits below
both an importer binding and (if the same source is ever reachable over HTTP) an
`http-extraction` source package, which is what keeps the graph acyclic. Do
**not** widen HAR's binding to cover it.

## 1. The decode

`FileImporterDescriptor.decode(fileBytes, settings)` reads a picked file's raw
bytes into the format's opaque review state — the picker stays format-blind,
so every format decodes bytes (HAR reads UTF-8 JSON, a LifeLabs PDF opens
binary through `positioned-text-web`). Its only failure is a malformed file
(a `ParseError`); it requires **no services** and writes nothing, so a preview
can never reach the write client by construction — the whole opt-in seam
rests on this.

For HAR, `decodeHar` runs `new TextDecoder().decode(bytes)` and then
`http-archive`'s `HttpArchive.LogFromHarJson`, restating each
`HttpArchive.Entry` as an `Extraction.Input` field-for-field (restated, not
passed through, so a drift is a compile error at the one seam the two
packages meet). For LifeLabs PDF, `decodeLifeLabsPdf` calls
`positioned-text-web`'s `extractPositionedText` on the raw bytes and hands
the extracted `Document.Type` to the dialect and the FHIR synthesis.

## 2. The pool

`pool` is the flat `HttpResponseKind<TParsed>[]` every decoded response is
recognized and decoded through, routed per response by **highest specificity**
(ties → list order). Recognition is per-URL: a mixed archive extracts every
recognized response, not one winning source. For a FHIR format, consume a source
package's **pre-adopted** kinds through its `SourceDescriptor` (HAR flattens
`fhir-r4-source`'s `fhirR4Source.responseKinds`, already keyed under each
response's own root — never re-adopt). Registering another source in the pool
is one static append of its descriptor.

## 3. The persist sink

`persist(resources, sourceRef)` writes the chosen resources and returns the ones
it could not write as `PersistFailure` data on a `never` error channel — one bad
write never stops the rest. **Don't write one** for a FHIR target: wrap
`fhir-r4`'s `persistResources`, stamping each resource's `meta.source` with the
source archive (`withMetaSource`), as `persistFhir` does. `fhir-r4`'s
`ResourceWriteFailure` satisfies `PersistFailure` structurally, so a drift is a
compile error at the binding. The write requirement (`R`, here
`FhirR4ResourcesHttpApiClient`) stays visible so the shell provides it.

## 4. The settings

`TSettings` is the format's per-import knobs; `defaultSettings` seeds the form.
HAR has none, so `HarSettings` is an empty record and `HarSettingsPicker` is a
no-op — the seam is present without inventing a setting. A format with real
settings (a redaction toggle, a column mapping) writes a `SettingsPicker` against
`SettingsPickerProps<TSettings>`.

## 5. The review body

The per-response review is **format-agnostic** — `importer-fundamentals`' `Review`
namespace owns recognition, the default pick (top specificity among enabled
kinds), the enabled-kind filter, and choose-then-persist (`Review.chosen`). Your
`ReviewBody` is a **view** over it: it holds a `Review.Selection` seeded from
`initialSelection` and reports changes up through `onChange`; the shell owns the
canonical selection per file. Reuse `har-importer-react`'s `ReviewBody` shape —
whole-import kind toggles, a per-response picker (static label for one kind, a
`<select>` on a real overlap), and a collapsible no-match section — rather than
re-deriving any of that logic. Anything about _what_ gets written belongs in
`Review`, not the view, so the shell and the view can never disagree.

## 6. Assemble the descriptor

`FileImporterDescriptor` bundles the four seams:

```ts
const myImporterDescriptor: FileImporterDescriptor<
  MySettings,
  FhirResource,
  FhirR4ResourcesHttpApiClient
> = {
  format: 'my-format',
  display: { title: '…', description: '…' },
  accept: ['.myfmt', 'application/my-format'],
  detect: (bytes, fileName) => fileName.toLowerCase().endsWith('.myfmt') || myMagic(bytes),
  defaultSettings: defaultMySettings,
  pool: myPool,
  decode: decodeMyFormat,
  persist: persistFhir,
}
```

`accept` is the descriptor's picker hint — the tokens the OS dialog's `accept`
attribute lists so a user sees this format's files in one composed picker. It
is never the format decision (drop and "All files" bypass it); the shell
composes the union of every registered format's tokens through
`importer-fundamentals`' `acceptFor`.

`detect` is the actual routing decision at the picker: the shell tries every
registered descriptor's `detect` on the picked bytes, and the first match
wins (`identify`). Keep it syntactic — an extension or a magic-bytes sniff —
so the full parse still runs only in `decode`.

## 7. Register in the shell

Add the two binding packages as dependencies of `importer-react`, run
`vp install`, and append a `FormatRegistration` to the closed `formatRegistry` in
`importer-react/src/registry.ts`:

```ts
const formatRegistry = {
  har: harRegistration,
  'my-format': {
    descriptor: myImporterDescriptor,
    SettingsPicker: MySettingsPicker,
    ReviewBody: MyReviewBody,
  },
} as const
```

The `FormatRegistration` interface requires all three parts, so a format missing
its descriptor, its settings picker, or its review body **fails to compile** here
rather than at runtime. That is the whole wiring — the `Format` union and the
shell's dispatch derive from the literal.

## 8. Tests per layer

Changes must include tests (see [AGENTS.md](../../../AGENTS.md) and the
`/javascript-testing-expert` command). Cover each layer where it lives:

- **Decode** — a fixture file decodes to the expected responses; a malformed file
  is a `ParseError`, not a throw.
- **Pool** — each kind's `tryRecognize` is `Some` for the right URLs and `None`
  for the neighbours; `parse` decodes a fixture.
- **Persist sink** — a failing write becomes one `PersistFailure`, not a raised
  error.
- **Review body** — the default pick is the top-specificity candidate; toggling a
  kind off re-derives every response's pick; the no-match section folds; the
  reported selection drives `Review.chosen`.
- **Shell** — the end-to-end flow: zero writes to reach a review, the confirm
  ordering (archive create before the first resource write, `meta.source` on every
  write), and a partial result. The existing `importer-screen.test.tsx` is the
  pattern.

## 9. Verify

```bash
vp run ready   # fmt + lint + lint:comments + lint:docs + pack + test:all
```

`vp run ready` is the pre-PR gate. No Rust is touched, so `./scripts/checks/rust.sh`
is a no-op here.

## See also

- [slices/importer AGENTS.md](../AGENTS.md) — package roles, guardrails, and the
  pick-review-confirm pipeline.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporterDescriptor` contract and the `Review` model.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the worked HAR
  binding this recipe generalizes.
- [Adding a Collector How-To](../../collector/docs/Adding%20a%20Collector%20How-To.md)
  — the live-transport counterpart, whose descriptor/registry shape this mirrors.
- [Documentation Reference](../../../docs/Documentation/Reference.md) — the
  four-kinds naming this doc follows.
