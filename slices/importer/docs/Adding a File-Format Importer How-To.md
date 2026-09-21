# Adding a File-Format Importer How-To

The end-to-end checklist for adding a new file format the importer can turn into
FHIR resources — a `.csv`, a `.json` export, another imaging archive. For _why_
the slice is layered the way it is, read
[slices/importer/AGENTS.md](../AGENTS.md) first; this doc is the recipe. HAR
(`har-importer-core` + `har-importer-react`), LifeLabs PDF, and DICOM are the
worked examples throughout.

A format is registered with exactly **two static edits** — its importer entry in
`importer-core`'s closed `formatRegistry`, and its `SettingsPicker` in
`importer-react`'s registry on top of it — because the slice has no runtime
registry. Everything before those edits lives in a new `*-importer-core` binding
(and its `*-importer-react` settings UI) built on `importer-fundamentals`'
`FileImporter.make`.

## What you're building

The importer slice mirrors the collector slice: a resource-agnostic
**fundamentals** layer (`importer-fundamentals`), a per-format **binding** (core +
React), a pure **core** (`importer-core`: the registry and the batch machinery),
and a **shell** (`importer-react`). A new format adds the binding and the two
registry entries; it touches neither `importer-fundamentals` nor
`http-extraction`. There is **no per-format review UI**: the shell renders every
format's decoded sections through one generalized per-resource review (include
checkboxes, inline JSON edit, diagnostic notes). A format's whole review surface
is what its `decodeOne` puts in each file's `DecodedFile` — sections of labeled
resources, plus a note per thing that did not become a resource.

| Piece           | Where                                          | Contract                                                      |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Decode dialect  | a pure dialect package (below both transports) | the format's document → structural records                    |
| Response kinds  | `slices/http-extraction/*-source/`             | `HttpResponseKind` — recognize + parse (only if HTTP-shaped)  |
| Importer        | `*-importer-core/src/<format>-importer.ts`     | one `FileImporter.make({ … })` call                           |
| Settings        | `*-importer-core/src/settings.ts`              | `TSettings` + `defaultSettings` (an empty record if none)     |
| Persistence     | shell-owned                                    | one shared `persistBatchBundle` — write no sink               |
| Source file     | the `sourceFileFormat` you pass in             | derived by `FileImporter.make`, minted inside `decode`        |
| Settings picker | `*-importer-react/src/settings-picker.tsx`     | `SettingsPickerProps<TSettings>` (`importer-fundamentals`)    |
| Registry entry  | `importer-core/src/registry.ts`                | `FormatSettings` + `formatRegistry` + `defaultFormatSettings` |
| Picker entry    | `importer-react/src/registry.ts`               | the same key's `SettingsPicker`                               |

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

You write **one file at a time**. `decodeOne(file, settings, sourceFile)` takes a
single `PickedFile` — a `{ fileName, bytes, source }`, the `source` being a
`local` pick or a `server` one naming a source file already on the device — and
yields a `DecodedFile`: titled sections of labeled resources, plus file-level
diagnostic notes.

```ts
const decodeMyFormat = (
  file: PickedFile,
  settings: MySettings,
  sourceFile: SourceFile.Reference
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> => …
```

`PerFileDecodeFunction.make` lifts that into the batch `decode(files, settings)`
the shell runs across every file the format claimed. That lifted decode is what:

- resolves each file's source file — minting one for a `local` pick and handing
  `decodeOne` its `DocumentReference/<id>` reference before the decode runs, or
  passing a `server` pick's existing reference through verbatim, minting
  nothing;
- prepends the minted row as its own **"Source file"** section;
- stamps every extracted resource's `meta.source` with that reference;
- **namespaces every review key** with the file's slot in the batch, so two
  claimed files cannot collide on a key (see the obligations below);
- folds a `ParseError` into that one file's `unreadableFiles` entry.

The resulting `decode` **never fails**, requires **no services**, and writes
nothing — so a preview can never reach the write client by construction, and one
bad file in a batch of five leaves the other four reviewable. The whole opt-in
seam rests on this.

The `sourceFile` argument is the resolved source file's reference, which is both
what every extracted resource's `meta.source` will carry and — through
`SourceFile.idFromReference` — where a format whose synthesized resources name
the stored file (DICOM's `ImagingStudy` `gridfsFileId` extension) reads the bare
id, rather than recomputing it.

Three obligations:

- **Stable resource keys.** A `DecodedFile.Resource`'s `key` must be stable
  across settings changes where the underlying resource is unchanged (HAR keys
  by `responseId:index`, DICOM by the resource's role), because the reviewer's
  per-resource exclusions and inline edits are keyed by it and must survive a
  settings re-decode. Key **within one file** and do not try to make keys unique
  across the batch yourself — `PerFileDecodeFunction.make` prefixes each file's keys with its
  slot (`FormatDecode.keyPrefix`), which is what makes a fixed key like
  `patient` safe when the reviewer picked eight images at once.
- **Sections are the display.** Pick a sectioning that means something to the
  reviewer: HAR sections by URL, LifeLabs by report. A section's `title` is the
  heading the shell renders.
- **Notes, not silence.** Anything the decode dropped (a response no kind
  matched, a body the archive never captured, a duplicate) becomes one note
  string, so the reviewer's opt-in stays informed.

## 2. The settings

`TSettings` is the format's per-import knobs; `defaultSettings` seeds
`importer-core`'s `FormatSettings` record. Settings are **pre-decode input**: the
shell mounts the format's `SettingsPicker` above its sections in the preview, and
a change re-runs `decode` on that format's files from their retained bytes.
Anything the user should be able to change about _how_ a file decodes is a
setting — HAR's response-kind toggles (`disabledKinds`), the LifeLabs report time
zone, and DICOM's equipment time zone all live here. There is no post-decode
review state besides the shell's per-resource selection.

## 3. Persistence — nothing to write

There is no `persist` field. Every FHIR-targeting importer writes through the
shell's one shared `persistBatchBundle` (`fhir-r4/clients`), so a binding brings
no write sink and names no write client — `FileImporter` takes no `R` parameter.
`importer-core`'s `planFormatWrite` turns a format's reviewed selection into the
exact list of resources to write, and the shell sends them as one `POST /` batch
bundle per format. The confirm adds nothing to any resource: the `meta.source`
links are already there, stamped by the decode.

## 4. The source file

A source file is the picked file itself, stored as a FHIR `DocumentReference`
with the bytes verbatim. It is **the format's**, not the shell's — but a binding
does not write the encoding. You pass `FileImporter.make` one **`sourceFileFormat`**
— a `SourceFileCodec.Format`, the same value the codec is parameterized by: a
`coding` (`{ system, code }`), a `contentType`, a `descriptionPrefix`
(conventionally `` `${display.title}: ` ``), and optionally a `securityLabel`.
It derives the whole seam from that:

| Derived field                     | What it is                                                  |
| --------------------------------- | ----------------------------------------------------------- |
| `categoryToken`                   | the `system\|code` search token the shell unions per format |
| `isSourceFile`                    | the disjoint predicate a server row is classified through   |
| `sourceFileFromDocumentReference` | the bytes-and-name reader a preview or a re-pick calls      |
| `sourceFileFormat`                | those constants as data, for the codec to be driven under   |

The write direction is not a field on the importer: minting and encoding a
source file is what the batch `decode` does either side of a `decodeOne`, so the
resource can be filed under a subject the decode named. `SourceFileCodec.mintResource`
(mint then encode, named for its result — the stored resource) and its halves
`SourceFileCodec.tryFromNamedBytes` / `SourceFileCodec.encode` are what it calls,
each requiring the codec's
`SourceFileCodec.FormatContext`. `sourceFileFormat` is that context's value, which is
how a binding's test drives the codec under the format's real config:

```ts
SourceFileCodec.mintResource({ fileName, bytes }).pipe(
  Effect.provideService(SourceFileCodec.FormatContext, myImporter.sourceFileFormat)
)
```

The `SourceFile` namespace beside it is the codec's _vocabulary_ — `Type`,
`Coding`, `Reference` and its two constructors — and is context-free. Reach for
`SourceFile` to name a source file and `SourceFileCodec` to store or read one.

The mint derives its id from the bytes' SHA-256 and the file name through
`fhir-r4/identity`'s `localResourceId`, so re-importing the same file under the
same name upserts rather than piling up duplicates, and it reads the clock for
the upload instant on every decode. A `server` pick mints nothing: its existing
`DocumentReference/<id>` reference is what the extracted resources stamp.

Pass **`subjectFor`** when the format files its source file under a subject. It
is called with the file _and its decode_, so it reads the subject off the
resources the decode already produced rather than parsing the file a second
time:

```ts
const patientSubjectOf: PerFileDecodeFunction.FileSubjectForPair = (_file, decoded) => {
  const patient = DecodedFile.resources(decoded).find(
    (entry) => entry.resource.resourceType === 'Patient'
  )
  const id = patient?.resource.id
  return id === undefined || id === null ? undefined : { reference: `Patient/${id}` }
}
```

The default is no `subject` at all, which keeps an engineering artifact out of
`Patient/$everything`; DICOM opts in because its header names the patient.

The minted source file is reviewed like any other resource. The reviewer can
exclude its row, in which case it is simply not written — and the extracted
resources keep their `meta.source`, because the decode stamped them and nothing
downstream rewrites them.

## 5. Assemble the importer

```ts
const display = { title: '…', description: '…' }

const sourceFileFormat = {
  coding: { system: MY_SYSTEM, code: MY_SOURCE_FILE_CODE },
  contentType: 'application/x-my-format',
  descriptionPrefix: `${display.title}: `,
  // optional:
  securityLabel: [{ system: MY_REDACTION_SYSTEM, code: 'raw' }],
}

const format = 'my-format'

const decodeConfig = {
  format,
  decodeOne: decodeMyFormat,
  // optional:
  subjectFor: mySubjectOf,
} as const

const myImporter = FileImporter.make({
  format,
  display,
  sourceFileFormat,
  decode: PerFileDecodeFunction.make(decodeConfig),
  detect: (bytes, fileName) => fileName.toLowerCase().endsWith('.myfmt') || myMagic(bytes),
  defaultSettings: defaultMySettings,
})
```

`PerFileDecodeFunction.make` returns a decode that still **needs** the
source-file context; `FileImporter.make` is what provides it, from the
`sourceFileFormat` in the same call. That is why you pass those constants once
and only once — the decode's mint and the importer's `categoryToken` /
`isSourceFile` then read the same copy by construction.

**`PerFileDecodeFunction` is one constructor, not the only one.** `DecodeFunction`
is the general contract — files and settings in, one `FormatDecode.Result` out —
and `per-file-decode-function.ts` is the one module that builds it under the
assumption that the files are independent. _Per-file_ is a real assumption: your
`decodeOne` is handed one file and cannot see the others, and the per-file
results sum into the batch's. If your format's files must be read _together_ — a
multi-part archive, a manifest naming its siblings — it is not per-file, and
needs its own constructor rather than a widened version of that one. Do not
smuggle cross-file state through `settings`.

`dicom-importer-core` is the worked example. Its unit is a **study**: the
files of one `StudyInstanceUID` make up one `ImagingStudy` whose counts,
modality set and earliest `started` no single file states. Its
`dicom-decode.ts` writes the `DecodeFunction.WithContext` directly, and what
it shares with `PerFileDecodeFunction` — resolving a pick to its
`SourceFile.Reference`, deferring the archive's encode until the decode has
named how to file it, listing the minted archives as their own section — comes
from `importer-fundamentals`' **`SourceFileMint`**. Write a group decode the
same way round: the machinery that is not about _your_ unit belongs in
`SourceFileMint`; the partition, the synthesis and the notes are yours. Four
obligations the shell still expects of any decode, which the per-file
constructor would otherwise have met for you:

- **namespace the unit's review keys** by the slot of the pick that opened it
  (`FormatDecode.keyPrefix`), so one unit's fixed keys cannot collide with
  another's;
- **stamp `meta.source`** on the unit's resources (`MetaSource.stampDecoded`).
  `meta.source` holds one reference, so a unit spanning files has to choose
  one archive to stand for it — choose it by the _unit's_ own order rather
  than the pick's, or the stamp changes with the order the files were picked
  in;
- **mint one archive per file**, each filed under a `SourceFileCodec.Filing`.
  `subject` says whose record the file is in; `related` (`context.related`)
  says which resources it is a source of, which is what lets the server list
  show a unit's archives as one unit and re-pick them together;
- **fold a failing unit into `unreadableFiles`**, one row per file of it, so
  the other units stay reviewable and `decode` still never fails.

The result is a plain record, not a class instance — which is what lets
`importer-react`'s registry extend it with a `SettingsPicker` by spreading it,
with nothing on a prototype to lose.

`detect` is the routing decision at the picker: the shell tries every registered
format's `detect` on the picked bytes, and the first match wins
(`FormatDetector.claiming` in `importer-fundamentals`, `groupByFormat` in
`importer-core`). Keep it syntactic — an extension or a magic-bytes sniff — so
the full parse still runs only in `decodeOne`. Your `format` and `detect`
together are all `FormatDetector.Type` asks for, which is how the picker sniffs
a file without naming your settings type.

## 6. Register

**The importer half, in `importer-core`.** Add the binding package as a
dependency of `importer-core`, run `vp install`, and extend four constructs —
all mapped or exhaustive types over `FormatKind`, so a format missed in any of
them **fails to compile**:

1. **`FormatSettings`** (`registry.ts`) — the type-level map from format to
   settings type.
2. **`formatRegistry`** (`registry.ts`) — the literal registry of importers.
3. **`defaultFormatSettings`** (`registry.ts`) — the default settings record.
4. **`collectFormats`** (`read-batch.ts`) — the one place that names every
   format literally, because TypeScript drops the correlation between a
   computed union key and its value (its remarks explain why).

`formatKinds` does **not** need an entry — it is derived from `formatRegistry`.

```ts
type FormatSettings = {
  har: HarSettings
  'lifelabs-pdf': LifeLabsPdfSettings
  dicom: DicomSettings
  'my-format': MySettings
}

const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: harImporter,
  'lifelabs-pdf': lifeLabsPdfImporter,
  dicom: dicomImporter,
  'my-format': myImporter,
}
```

**The UI half, in `importer-react/src/registry.ts`.** Add the
`*-importer-react` package as a dependency of `importer-react`, run
`vp install`, and add the React parts a format contributes — its settings
picker, and optionally a `FilePreview` the server source file list's preview
dialog renders in place of its content-type dispatch:

```ts
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  …,
  'my-format': withComponents(coreRegistry['my-format'], {
    SettingsPicker: MySettingsPicker,
  }),
}
```

`BoundFormat<K>` requires every part typed against the format's `FormatSettings`
entry, so a format missing its settings picker **fails to compile** rather than
at runtime. The read and write halves need no new branch: `importer-core`
dispatches generically (`<K extends FormatKind>(kind: K)` keeps `registry[kind]`
and `settings[kind]` correlated), and the confirm is format-blind.

## 7. Tests per layer

Changes must include tests (see [AGENTS.md](../../../AGENTS.md) and the
`/javascript-testing-expert` command). Cover each layer where it lives:

- **Decode** — a fixture file decodes to the expected sections and notes; keys
  are stable across a settings change. Pin the source-file contract too: a
  `local` pick yields a "Source file" first section and `meta.source` on every
  extracted resource, a `server` pick yields no such section (and stamps the
  pick's existing reference), and malformed bytes yield an `unreadableFiles`
  entry rather than a failed Effect.
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
  `FileImporter` contract, the source-file seam, and the `StagedImport` model.
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
