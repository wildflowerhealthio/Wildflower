# Adding a File-Format Importer How-To

The end-to-end checklist for adding a new file format the importer can turn into
FHIR resources — a `.csv`, a `.json` export, another imaging archive. For _why_
the slice is layered the way it is, read
[slices/importer/AGENTS.md](../AGENTS.md) first; this doc is the recipe. HAR
(`har-importer-core` + `har-importer-react`), LifeLabs PDF, and DICOM are the
worked examples throughout.

A format is registered with exactly **two static edits** — its descriptor entry
in `importer-core`'s closed `formatRegistry`, and its `SettingsPicker` in
`importer-react`'s registry on top of it — because the slice has no runtime
registry. Everything before those edits lives in a new `*-importer-core` binding
(and its `*-importer-react` settings UI) that implements the
`importer-fundamentals` contract.

## What you're building

The importer slice mirrors the collector slice: a resource-agnostic
**fundamentals** layer (`importer-fundamentals`), a per-format **binding** (core +
React), a pure **core** (`importer-core`: the registry and the batch machinery),
and a **shell** (`importer-react`). A new format adds the binding and the two
registry entries; it touches neither `importer-fundamentals` nor
`http-extraction`. There is **no per-format review UI**: the shell renders every
format's decoded sections through one generalized per-resource review (include
checkboxes, inline JSON edit, diagnostic notes). A format's whole review surface
is what its `decode` puts in each unit's `DecodedFile` — sections of labeled
resources, plus a note per thing that did not become a resource.

| Piece           | Where                                          | Contract                                                     |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Decode dialect  | a pure dialect package (below both transports) | the format's document → structural records                   |
| Response kinds  | `slices/http-extraction/*-source/`             | `HttpResponseKind` — recognize + parse (only if HTTP-shaped) |
| Descriptor      | `*-importer-core/src/*-importer.ts`            | `decode` plus the four `sourceFile*` server-read fields      |
| Settings        | `*-importer-core/src/*-settings.ts`            | `TSettings` + `defaultSettings` (an empty record if none)    |
| Persistence     | shell-owned                                    | one shared `persistBatchBundle` — write no sink              |
| Source file     | `*-importer-core/src/source-file/`             | thin config over `sourceFileCodec`, minted inside `decode`   |
| Settings picker | `*-importer-react/src/settings-picker.tsx`     | `SettingsPickerProps<TSettings>` (`importer-fundamentals`)   |
| Registry entry  | `importer-core/src/registry.ts`                | one descriptor entry + `FormatVariant` / defaults / order    |
| Picker entry    | `importer-react/src/registry.ts`               | the same key's `SettingsPicker`                              |

## When a format is _not_ HTTP traffic

HAR is the odd one out: its contents _are_ HTTP traffic, so it recognizes each
archived exchange against `slices/http-extraction`'s response kinds and sections
its output by URL. A format whose contents are a **document** (a CSV, a DICOM
file, a LifeLabs report PDF) does not have HTTP responses. Its decode belongs in
a pure dialect (the way the LifeLabs positioned-text dialect works), and its
sections come from the document's own structure — the LifeLabs binding emits one
section per report, titled by the report's `Lab No` and date of service. The
dialect sits below both an importer binding and (if the same source is ever
reachable over HTTP) an `http-extraction` source package, which is what keeps
the graph acyclic. Do **not** widen HAR's binding to cover it.

## 1. The decode

`FileImporterDescriptor.decode(files, settings)` takes the whole batch of
`PickedFile`s this format claimed — each a `{ fileName, bytes, source }`, the
`source` being a `local` pick or a `server` one naming a source file already on
the device — and yields one `DecodeOutcome` per **unit** the format decides on.
A unit is either `read` (a `title`, the `files` it came from, and a
`DecodedFile<TParsed>` of titled `LabeledSection`s of `LabeledResource`s plus
file-level diagnostic notes) or `unreadable` (the same `title` and `files`, plus
the malformed-input `ParseError`).

`decode` **never fails**, requires **no services**, and writes nothing — so a
preview can never reach the write client by construction, and one bad file in a
batch of five leaves the other four reviewable. The whole opt-in seam rests on
this.

Most formats are single-file: one picked file, one unit. Those wrap a per-file
decode with **`perFileDecode`** from `importer-fundamentals`:

```ts
const decodeMyFormat = (
  file: PickedFile,
  settings: MySettings,
  source: SourceFileRef
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> => …

const decode = perFileDecode(mySourceFileCodec, decodeMyFormat)
```

`perFileDecode` mints each `local` pick's source-file `DocumentReference`
through the codec, prepends it as its own "Source file" section, stamps every
extracted resource's `meta.source` with it, titles the unit by the file name,
and folds a `ParseError` into that file's own `unreadable` unit. The `source`
argument carries the source file's `id` and `DocumentReference/<id>` reference,
so a format whose synthesized resources name the stored file (DICOM's
`ImagingStudy` `gridfsFileId` extension) reads it there rather than recomputing
it. Pass `{ subjectFor }` when the minted source file should link to a subject —
DICOM derives a `Patient/<id>` from the file's header so the raw file rides
along in that patient's record.

A **group** format (several `.dcm` files merged into one study unit) implements
`decode` itself and composes the same pieces from
`importer-fundamentals`' `source-file-review.ts`: call `sourceFileFor(codec,
file)` per file, prepend the minted rows with `withSourceSections`, stamp
`meta.source` itself (`stampMetaSource` / `withMetaSource` — FHIR's
`meta.source` is one URI, so a resource decoded from several files names one of
them, and which one is the format's call), decide each unit's `title`, and
return an `unreadable` unit rather than failing.

Three obligations, whichever shape you take:

- **Stable resource keys.** `LabeledResource.key` must be stable across
  settings changes where the underlying resource is unchanged (HAR keys by
  `responseId:index`, a source file by `sourceFileKey(fileName)`), because the
  reviewer's per-resource exclusions and inline edits are keyed by it and must
  survive a settings re-decode.
- **Sections are the display.** Pick a sectioning that means something to the
  reviewer: HAR sections by URL, LifeLabs by report. A section's `title` is
  the heading the shell renders, and the unit's `title` is what the review
  heads the whole unit with.
- **Notes, not silence.** Anything the decode dropped (a response no kind
  matched, a body the archive never captured, a duplicate) becomes one note
  string, so the reviewer's opt-in stays informed.

## 2. The settings

`TSettings` is the format's per-import knobs; `defaultSettings` seeds
`importer-core`'s `FormatSettings` record. Settings are **pre-decode input**: the
shell mounts the format's `SettingsPicker` above its units in the preview, and a
change re-runs `decode` on that format's units from their retained files.
Anything the user should be able to change about _how_ a file decodes is a
setting — HAR's response-kind toggles (`disabledKinds`), the LifeLabs report time
zone, and DICOM's equipment time zone all live here. There is no post-decode
review state besides the shell's per-resource selection.

## 3. Persistence — nothing to write

There is no `persist` field. Every FHIR-targeting importer writes through the
shell's one shared `persistBatchBundle` (`fhir-r4/clients`), so a binding brings
no write sink and names no write client — the `FileImporterDescriptor` takes no
`R` parameter. `importer-core`'s `planUnitWrite` turns a reviewed unit into the
exact list of resources to write, and the shell sends them as one `POST /` batch
bundle per unit. The confirm adds nothing to any resource: the `meta.source`
links are already there, stamped by the decode.

## 4. The source file

A source file is the picked file itself, stored as a FHIR `DocumentReference`
with the bytes verbatim. It is **the format's**, not the shell's: the descriptor
has no `buildSourceFile` field, and nothing above the binding mints one.

`*-importer-core/src/source-file/` is a thin config over
`importer-fundamentals`' shared **`sourceFileCodec`** (`src/source-file-codec.ts`)
— pass your coding, content type, description prefix, `sourceFileName`, `label`,
`idDescription`, and (if any) `securityLabel` as data, and re-export only what
your binding consumes: the codec itself, `categoryToken`, `isSourceFile`,
`sourceFileFromDocumentReference`, and the content type. See
`har-importer-core/src/source-file` for the worked example.

The codec's own **`buildSourceFile`** is what `perFileDecode` (or your group
decode, via `sourceFileFor`) calls per `local` pick. It derives a
**deterministic** id from the bytes' SHA-256 and the file name through
`fhir-r4/identity`'s `localResourceId`, so re-importing the same file under the
same name upserts rather than piling up duplicates, and it reads the clock for
the upload instant on every decode. A `server` pick mints nothing: its existing
`DocumentReference/<id>` reference is what the extracted resources stamp.

Pass `subjectFor` to `perFileDecode` (or a `subject` to `sourceFileFor`) when the
format links the file to a subject. The default is no `subject` at all, which
keeps an engineering artifact out of `Patient/$everything`; DICOM opts in because
its header names the patient.

The minted source file is reviewed like any other resource. The reviewer can
exclude its row, in which case it is simply not written — and the extracted
resources keep their `meta.source`, because the decode stamped them and nothing
downstream rewrites them.

## 5. Assemble the descriptor

```ts
const myImporterDescriptor: FileImporterDescriptor<MySettings, FhirResource> = {
  format: 'my-format',
  display: { title: '…', description: '…' },
  detect: (bytes, fileName) => fileName.toLowerCase().endsWith('.myfmt') || myMagic(bytes),
  defaultSettings: defaultMySettings,
  decode: perFileDecode(mySourceFileCodec, decodeMyFormat),
  // the server-read seam (re-picking uploaded source files from the server):
  sourceFileCategoryToken: MY_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isMySourceFile,
  sourceFileFromDocumentReference: readMySourceFile,
  sourceFileContentType: MY_SOURCE_FILE_CONTENT_TYPE,
}
```

`detect` is the routing decision at the picker: the shell tries every registered
descriptor's `detect` on the picked bytes, and the first match wins (`identify`
in `importer-fundamentals`, `groupByFormat` in `importer-core`). Keep it
syntactic — an extension or a magic-bytes sniff — so the full parse still runs
only in `decode`.

The four `sourceFile*` fields are the server-read seam, all sourced from your
`/source-file` codec so a reader cannot drift from what the mint writes: the
`system|code` search token the shell unions across formats, the disjoint
`isSourceFile` predicate each returned row is classified through, the
bytes-and-name reader a preview or a re-pick calls, and the content type that
picks the preview modal's renderer (PDF via `<iframe>`, JSON via `<pre>`).

## 6. Register

**The descriptor half, in `importer-core/src/registry.ts`.** Add the binding
package as a dependency of `importer-core`, run `vp install`, and extend the four
registry constructs: the `FormatVariant` type-level map (the format's `settings`
/ `parsed` pair), the `formatRegistry` literal, the `defaultFormatSettings`
record, and the `formatKinds` order:

```ts
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: { ...harImporterDescriptor, format: 'har' },
  'lifelabs-pdf': { ...lifeLabsPdfImporterDescriptor, format: 'lifelabs-pdf' },
  'my-format': { ...myImporterDescriptor, format: 'my-format' },
}
```

**The UI half, in `importer-react/src/registry.ts`.** Add the
`*-importer-react` package as a dependency of `importer-react`, run
`vp install`, and add the one React part a format contributes:

```ts
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  …,
  'my-format': { ...coreRegistry['my-format'], SettingsPicker: MySettingsPicker },
}
```

`BoundFormat<K>` requires every part typed against the format's `FormatVariant`
entry, so a format missing a descriptor field or its settings picker **fails to
compile** rather than at runtime. The read and write halves need no new branch:
`importer-core` dispatches generically (`<K extends FormatKind>(kind: K)` keeps
`registry[kind]` and `settings[kind]` correlated), and the confirm is
format-blind. The one `Match.exhaustive` site left is the preview panel's
settings form, which gains one branch — and the compiler points at it.

## 7. Tests per layer

Changes must include tests (see [AGENTS.md](../../../AGENTS.md) and the
`/javascript-testing-expert` command). Cover each layer where it lives:

- **Decode** — a fixture file decodes to the expected sections and notes; keys
  are stable across a settings change. Pin the source-file contract too: a
  `local` pick yields a "Source file" first section and `meta.source` on every
  extracted resource, a `server` pick yields no such section (and stamps the
  pick's existing reference), and malformed bytes yield an `unreadable` unit
  rather than a failed Effect.
- **Settings picker** — a change reports the next settings value verbatim.
- **Shell** — the end-to-end flow: zero writes to reach a review, the confirm
  (the source file and the resources in one bundle, `meta.source` on every
  write), and a partial result. The existing `importer-screen.test.tsx` is the
  pattern.

## 8. Verify

```bash
vp run ready   # fmt + lint + lint:comments + lint:docs + pack + test:all
```

`vp run ready` is the pre-PR gate. No Rust is touched, so `./scripts/checks/rust.sh`
is a no-op here.

## See also

- [slices/importer AGENTS.md](../AGENTS.md) — package roles, guardrails, and the
  pick-review-confirm pipeline.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporterDescriptor` contract, the source-file helpers, and the
  `StagedImport` model.
- [importer-core AGENTS.md](../importer-core/AGENTS.md) — the closed registry and
  the batch machinery the two registry edits feed.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the worked HAR
  binding this recipe generalizes.
- [lifelabs-pdf-importer-core AGENTS.md](../lifelabs-pdf-importer-core/AGENTS.md)
  — the worked document-format binding.
- [dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md) — the worked
  binding that links a subject and reads its source file's id in the decode.
- [Adding a Collector How-To](../../collector/docs/Adding%20a%20Collector%20How-To.md)
  — the live-transport counterpart, whose descriptor/registry shape this mirrors.
- [Documentation Reference](../../../docs/Documentation/Reference.md) — the
  four-kinds naming this doc follows.
