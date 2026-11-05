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
`DecodeFunction.make`.

## What you're building

The importer slice is layered as a resource-agnostic
**fundamentals** layer (`importer-fundamentals`), a per-format **binding** (core +
React), a pure **core** (`importer-core`: the registry and the batch machinery),
and a **shell** (`importer-react`). A new format adds the binding and the two
registry entries; it touches neither `importer-fundamentals` nor
`http-extraction`. There is **no per-format review UI**: the shell renders every
format's decoded sections through one generalized per-resource review (include
checkboxes, inline JSON edit, diagnostic notes). A format's whole review surface
is what its `decodeFileSet` returns — sections of labeled resources, plus a
note per thing that did not become a resource.

| Piece           | Where                                          | Contract                                                      |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Decode dialect  | a pure dialect package (below both transports) | the format's document → structural records                    |
| Response kinds  | `slices/http-extraction/*-source/`             | `HttpResponseKind` — recognize + parse (only if HTTP-shaped)  |
| Importer        | `*-importer-core/src/<format>-importer.ts`     | one `FileImporter.Type` literal over `DecodeFunction.make`    |
| Settings        | `*-importer-core/src/settings.ts`              | `TSettings` + `defaultSettings` (an empty record if none)     |
| Persistence     | shell-owned                                    | one shared `persistBatchBundle` — write no sink               |
| Source file     | the `sourceFileFormat` you state               | minted by `importer-core`'s import stage                      |
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

You write **one file set at a time**. `decodeFileSet(pickedFiles, settings)` takes
the picked files that are decoded together — each a `PickedFile.Type`
(`{ id, fileName, bytes }`, the `id` being the slot the batch read gave it) —
and yields a `DecodeFunction.FileSetDecode`: titled sections of labeled,
**detached** resources, plus diagnostic notes.

```ts
const decodeMyFormat = (
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  settings: MySettings
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> => …
// each section:
//   {
//     title,
//     entries: resources.map((resource) => ({ fullUrl, resource })),
//   }
```

Write each resource detached (`fhir-r4-adoption`'s `DetachedResource`): no
`id`, keyed by its `identifier[0]` (`DetachedResource.keyIdentifierWire`), and
linked to your other resources by logical reference by their key
(`DetachedResource.logicalReferenceWire`). Key a record by a real identifier
the file prints, in that identifier's own system (LifeLabs keys a report by
its `Lab No`, a Patient by its `Patient ID` or health card number); where the
file prints none for a record that must be referenced, use a Wildflower-minted
system with a readable value made of what it does print (LifeLabs' result rows
and providers), never a digest (DICOM still keys by one; #1508 moves it to
its files' issuers). A record nothing references may stay keyless.
Decode each wire with `DetachedResource.decodeUnknown(<Type>.Schema)`, which
fails a wire that carries an `id`. A section carries no source base URL or
system: everything the import stage needs is on the records. An entry's `fullUrl` is its identity within the
set, as in a FHIR transaction bundle, and must be stable across a settings
re-decode. The import stage titles every row by the reference it will be
written under (`DecodedFileSet.writtenReferenceTitle`), and makes every `wf-`
id; the decode makes neither.

A format whose files stand alone reads `pickedFiles[0]` and says nothing more:
each picked file is its own set by default, in the order the files were picked.
A format whose files must be read **together** — a multi-part archive, a
manifest naming its siblings, a DICOM study — states a `groupBy` instead (see
§5).

`DecodeFunction.make` lifts that into the batch `decode(files, settings)` the
shell runs across every file the format claimed. That lifted decode:

- **namespaces every `fullUrl`** with the set's first picked file, so two sets
  cannot collide on a key (see the obligations below);
- folds a `ParseError` into one `unreadableFiles` row per picked file of the
  failing set;
- returns each set apart with its picked files and its sections.

`importer-core`'s import stage (`importDecoded`, which `readBatch` runs over
every format's `decode`) then, per set:

- mints a source file for **every** picked file, its `masterIdentifier` what
  the picked file identified itself as (§1);
- adopts the set's records (`DecodedFileSet.adopt`): a keyed record under the
  `wf-` id its key derives, a keyless one under a random id, and each logical
  reference to a record of the set resolved to a literal one (a reference to
  anything else stays logical, for the identity map), so every record has its id
  before the hooks below run;
- lets the format link each source file to what the set decoded to
  (`linkSourceFile`, §4) and each record to the source files it was read from
  (`linkToSourceFiles`, §4), and prepends the source files as their own
  **"Source file"** / **"Source files"** section;
- stamps every extracted resource's `meta.source` with the set's representative
  source file — the one with the lexicographically smallest id, which is a content
  hash, so the stamp is the same however the files were picked;
- reports every picked file of a set as an `unreadableFiles` row when its
  source files cannot be built or `linkToSourceFiles` fails
  (`FileImporter.SourceFileNotFound`), leaving the other sets reviewable.

The decode and the import **never fail**, require **nothing but what your
`decodeFileSet` requires**, and write nothing — so a preview can never reach the
write client by construction, and one bad file in a batch of five leaves the
other four reviewable. The whole opt-in seam rests on this.

A format that needs a platform library to read its bytes keeps its binding
pure by requiring that library as an Effect service rather than importing it.
LifeLabs' `decodeFileSet` requires `positioned-text`'s
`PositionedTextExtractor`, so its importer is a
`FileImporter.Type<LifeLabsPdfSettings, 'lifelabs-pdf', PositionedTextExtractor>`.
The requirement surfaces at `importer-core`'s `readBatch` as part of
`DecodeRequirements`, and `importer-react` provides the adapter's layer
(`positioned-text-web`'s `positionedTextExtractorPdfjs`) where it runs the read.
A new service of this kind is one more `Effect.provide` there. Tests provide a
fake layer built from hand-written fixtures.

A format whose records name the stored file they were read from (DICOM's
`ImagingStudy` `gridfsFileId` extension) does not name it at decode: a decode
never sees a source file. Its `decodeFileSet` instead says what each picked
file's own content identifies it as: beside its sections it returns
`pickedFiles`, each picked file it was handed paired with a FHIR `Identifier`
as `identifiedAs` (`DecodedFileSet.PickedFileIdentity`; DICOM: the SOP Instance
UID as `urn:oid:<uid>` under `urn:ietf:rfc:3986`). The import stage writes that
onto the file's source file as `masterIdentifier`, and the format's
`linkToSourceFiles` (§4) matches each record to a source file by it. A format
whose files name nothing leaves `pickedFiles` out, and each picked file
identifies as nothing.

Four obligations:

- **Stable resource keys.** A section entry's `key` must be stable
  across settings changes where the underlying resource is unchanged (HAR keys
  by `responseId:index`, DICOM by the resource's role), because the reviewer's
  per-resource exclusions and inline edits are keyed by it and must survive a
  settings re-decode. Key **within one set** and do not try to make keys unique
  across the batch yourself — `DecodeFunction.make` prefixes each set's keys
  with its first picked file (`FormatDecode.keyPrefix`), which is what makes
  a fixed key like `patient` safe when the reviewer picked eight images at once.
- **Sections are the display.** Pick a sectioning that means something to the
  reviewer: HAR sections by URL, LifeLabs by report. A section's `title` is the
  heading the shell renders.
- **Notes, not silence.** Anything the decode dropped (a response no kind
  matched, a body the archive never captured, a duplicate) becomes one note
  string, so the reviewer's opt-in stays informed.
- **Every patient and provider names its identity.** The shell's identity map
  links the people and providers a batch names to the device's; it can only
  link what a resource identifies. A `subject`, `requester` or `performer`
  carries a literal to a `Patient` or `Practitioner` the same decode emits, or
  is a logical reference: `type` stated, and an `identifier` with both
  `system` and `value`. A provider known only by a printed name is `fhir-r4`'s
  `Practitioner.tryReferenceFromName(<name>)` (or its
  `tryReferenceWireFromName`), the name identifier beside the `display`, as
  the Shoppers and Rexall prescribers and DICOM's referring physician are. A
  `display`-only reference, or an identifier-only one that states no type,
  names nobody the map can link. See the
  [Source Identity Explanation](../../http-extraction/fhir-r4-adoption/docs/Source%20Identity%20Explanation.md#the-identity-map).

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
shell's one shared `persistTransactionBundle` (`fhir-r4/clients`), so a binding
brings no write sink and names no write client — `FileImporter` takes no `R`
parameter. `importer-core`'s `planWrite` turns the batch's reviewed selections
into a `WriteDecision` per reviewed resource, and the shell sends the
`Included` ones, every format's and the batch's linked records, as one
`POST /` transaction bundle. The confirm adds nothing to any resource: the
`meta.source` links are already there, set by the import stage.

## 4. The source file

A source file is the picked file itself, stored as a FHIR `DocumentReference` with
the bytes verbatim. It is **the format's**, not the shell's — but a binding does
not write the encoding. You state one **`sourceFileFormat`** — a
`PickedFile.FormatValue`: a `coding` (`{ system, code }`), a `contentType`, a
`descriptionPrefix` (conventionally `` `${display.title}: ` ``), and optionally
a `securityLabel` — on the importer, and the import stage mints under it.
Everything else is `PickedFile`'s, read under those constants:

| What you need                           | How to get it                                         |
| --------------------------------------- | ----------------------------------------------------- |
| the `system\|code` search token         | `PickedFile.categoryToken(sourceFileFormat)`          |
| the disjoint predicate for a server row | `PickedFile.isSourceFile(sourceFileFormat)(resource)` |
| the name-and-bytes reader               | `Schema.decode(PickedFile.FromDocumentReference)`     |

That schema requires the `PickedFile.Format` service. The import stage
provides it internally from your importer's `sourceFileFormat`, so nothing
your binding exports carries the requirement; a reader above the binding — the
shell's server source-file list, or your binding's own test — provides it from
the importer's own constants:

```ts
Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
  Effect.provideService(PickedFile.Format, myImporter.sourceFileFormat)
)
```

Encoding a pick **mints**: the id is the bytes' SHA-256 and the file name
through `fhir-r4/identity`'s `localResourceId`, namespaced by the coding system,
so re-importing the same file under the same name upserts rather than piling up
duplicates — and a file re-picked off the server mints exactly the source file it
came from, which the server diff then reads as `unchanged` and the initial
selection pre-excludes. The source file carries **no instant**: what it states is
what the file _is_, and when it reached the device is the server's own
`meta.lastUpdated`. The encode ignores the value's own `id`, and reading an
source file back yields the stored one, so decode-then-encode is the identity on it.

State **`linkSourceFile`** on the importer when the format's source files should
point at what was read out of them. The import stage calls it once for each
picked file, with that file's source-file `DocumentReference` as built and
every record the file's set decoded to, and stores the `DocumentReference` it
returns. It reads the links off the records already produced rather than
parsing the files a second time:

```ts
const linkToPatientAndStudy = (
  sourceFile: DocumentReference.Type,
  decoded: DecodedFile.DecodedFile
): DocumentReference.Type => ({
  ...sourceFile,
  subject: patientReferenceOf(decoded),
  context: { ...(sourceFile.context ?? emptyContext), related: relatedOf(decoded) },
})
```

**Do not change the `id`.** It is a hash of the file's bytes and name, which is
what makes importing the same file again update the one stored copy instead of
adding a second; the review row and every record's `meta.source` use whatever
id you return. The default is the source file as built — no `subject`, no `related` —
which keeps an engineering artifact out of `Patient/$everything`; DICOM opts in
because its header names the patient, and its `related` is what tells a reader
of the server list which study a source file was read into. The source file is reviewed
like any other resource. The reviewer can exclude its row, in which case it is
simply not written — and the extracted resources keep their `meta.source`,
because the import stamped them and nothing downstream rewrites them.

State **`linkToSourceFiles`** on the importer when a record should name the
file it was read from. The import stage calls it once for each record of a
set, after `linkSourceFile` has run, with the record and each picked file of
the set beside its source file (`FileImporter.PickedSourceFile`), and stores
the record its effect returns. It finds a record's file by the source file's
`masterIdentifier` (§1), reading only FHIR. DICOM's `addGridfsFileIds` sets
each `ImagingStudy` instance's `gridfsFileId` to the id of the source file
whose `masterIdentifier` is the instance's SOP Instance UID, so the OHIF viewer
can fetch the instance's image. A record that names a file no source file of
the set identifies as fails with `FileImporter.SourceFileNotFound`, which
reports that set's picked files as unreadable. Left out, every record is
stored as it is.

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

const myImporter: FileImporter.Type<MySettings, typeof format> = {
  format,
  display,
  detect: (bytes, fileName) => fileName.toLowerCase().endsWith('.myfmt') || myMagic(bytes),
  defaultSettings: defaultMySettings,
  sourceFileFormat,
  // only when your source files link to what was read out of them:
  linkSourceFile: linkMySourceFile,
  // only when a record names the file it was read from:
  linkToSourceFiles: linkMyRecordToSourceFiles,
  decode: DecodeFunction.make({
    format,
    decodeFileSet: decodeMyFormat,
    // only when your files are read together:
    groupBy: myGroupKey,
  }),
}
```

The importer is a **literal**, not a constructor call: every field is either a
constant you state or a function you already have. `sourceFileFormat` is spelled
once, on the importer, where both the import stage's mint and a reader of the
server list read it, so the two cannot disagree.

**A format whose files are read together states a `groupBy`.** It is called per
picked file and returns the key that file shares with its set-mates, or a `Left`
when the file states none — which reports it as its own `unreadableFiles` row,
ahead of any failing set, in the order the files were picked. Sets come out in
the order the picked files that opened them arrived. Nothing else changes — the
key namespacing and the failure folding are the constructor's, and the mint, the
source file section and the `meta.source` stamp the import stage's, either way.

`dicom-importer-core` is the worked example. What decodes together there is a
**study**: the files of one `StudyInstanceUID` (and patient) make up one
`ImagingStudy` whose counts, modality set and earliest `started` no single file
states. Its `studyGroupKey` parses the header and returns `studyKey(header)`.
Parsing there and again in `decodeStudy` is deliberate: there is no parsed-value
passthrough, and the second parse buys a constructor with one less concept in
it. Nothing about the set depends on the order it was picked in — the
representative whose source file stamps `meta.source` is the picked file with the
smallest source file id, and a source file id is a content hash. `meta.source` holds
one reference, so a set spanning files keeps per-file provenance some other way:
DICOM's `linkToSourceFiles` sets on each `ImagingStudy.instance` its own
source file's id (`gridfsFileId`).

Do not smuggle cross-file state through `settings`: `groupBy` is where "these
files belong together" is said.

The result is a plain record, not a class instance — which is what lets
`importer-react`'s registry extend it with a `SettingsPicker` by spreading it,
with nothing on a prototype to lose.

`detect` is the routing decision at the picker: the shell tries every registered
format's `detect` on the picked bytes, and the first match wins
(`FormatDetector.claiming` in `importer-fundamentals`, `groupByFormat` in
`importer-core`). Keep it syntactic — an extension or a magic-bytes sniff — so
the full parse still runs only in `decodeFileSet`. Your `format` and `detect`
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
  are stable across a settings change. Pin the source file contract too: a pick
  yields a "Source file" first section and `meta.source` on every extracted
  resource, the minted id is the same for the same bytes and name, and malformed
  bytes yield an `unreadableFiles` entry rather than a failed Effect. A format
  with a `groupBy` also pins the grouping itself: which picks share a key, which
  are `Left`, and that the resources are identical whatever order the files were
  picked in.
- **Settings picker** — a change reports the next settings value verbatim.
- **Shell** — the end-to-end flow: zero writes to reach a review, the confirm
  (the source file and the resources in one bundle, `meta.source` on every
  write), and a partial result. The existing `importer-screen.test.tsx` is the
  pattern.
- **Import golden pin** — `synthetic-data-core-js`'s
  `src/import-golden/import-golden.test.ts` imports a fixed file of every source
  kind, and one batch of several, headless through `importer-core` with every
  default accepted onto an empty device. It compares what the confirm would
  write — every resource's JSON, and that of every row the review leaves
  out, the review rows with their keys and dispositions, the decode notes,
  and the id each written source file mints when it is picked again — byte
  for byte with its golden under `src/import-golden/__golden__/`. Add a case
  for a new format. A golden that changes is a change to what an import
  writes, so a refactor's diff carries none; when a change is meant to alter
  the output, regenerate with `vp test -u` in that package and review the
  golden diff with the rest.

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
- [importer-core AGENTS.md](../../../slices/importer/importer-core/AGENTS.md) — the closed registry and
  the batch machinery the two registry edits feed.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the worked HAR
  binding this recipe generalizes.
- [lifelabs-pdf-importer-core AGENTS.md](../lifelabs-pdf-importer-core/AGENTS.md)
  — the worked document-format binding.
- [dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md) — the worked
  binding that states a `groupBy`, links its source files, and reads each source file's
  id in the decode.
- [Documentation Reference](../../../docs/Documentation/Reference.md) — the
  four-kinds naming this doc follows.
