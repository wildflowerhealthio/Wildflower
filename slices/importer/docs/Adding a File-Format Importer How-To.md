# Adding a File-Format Importer How-To

The end-to-end checklist for adding a new file format the importer can turn into
FHIR resources — a `.csv`, a `.json` export, a DICOM archive. For _why_ the slice
is layered the way it is, read [slices/importer/AGENTS.md](../AGENTS.md) first;
this doc is the recipe. HAR (`har-importer-core` + `har-importer-react`) and
LifeLabs PDF (`lifelabs-pdf-importer-core` + `lifelabs-pdf-importer-react`) are
the worked examples throughout.

A format is registered with exactly **one static edit** — its `BoundFormat`
entry in `importer-react`'s closed `formatRegistry` — because the slice has no
runtime registry. Everything before that edit lives in a new `*-importer-core`
binding (and its `*-importer-react` settings UI) that implements the
`importer-fundamentals` contract.

## What you're building

The importer slice mirrors the collector slice: a resource-agnostic
**fundamentals** layer (`importer-fundamentals`), a per-format **binding** (core +
React), and a **shell** (`importer-react`). A new format adds the binding and one
registry entry; it touches neither `importer-fundamentals` nor `http-extraction`.
There is **no per-format review UI**: the shell renders every format's decoded
sections through one generalized per-resource review (include checkboxes, inline
JSON edit, diagnostic notes). A format's whole review surface is what its
`decode` puts in the `DecodedFile` — sections of labeled resources, plus a note
per thing that did not become a resource.

| Piece           | Where                                              | Contract                                                         |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Decode dialect  | a pure dialect package (below both transports)     | the format's document → structural records                       |
| Response kinds  | `slices/http-extraction/*-source/`                 | `HttpResponseKind` — recognize + parse (only if HTTP-shaped)     |
| Descriptor      | `*-importer-core/src/*-importer.ts`                | `decode` / `sourceArchive` / archive-read seam                   |
| Settings        | `*-importer-core/src/*-settings.ts`                | `TSettings` + `defaultSettings` (an empty record if none)        |
| Persistence     | shell-owned                                        | one shared `persistBatchBundle` — write no sink                  |
| Source archive  | `*-importer-core/src/archive/`                     | the picked file as a reviewed `DocumentReference`                |
| Settings picker | `*-importer-react/src/settings-picker.tsx`         | `SettingsPickerProps<TSettings>` (`importer-fundamentals`)       |
| Registry entry  | `importer-react/src/registry.ts`                   | one `BoundFormat` entry + `FormatVariant` / defaults / order     |

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

`FileImporterDescriptor.decode(fileBytes, settings)` reads a picked file's raw
bytes into a `DecodedFile<TParsed>` — titled `LabeledSection`s of
`LabeledResource`s plus file-level diagnostic note strings. The picker stays
format-blind, so every format decodes bytes (HAR reads UTF-8 JSON, a LifeLabs
PDF opens binary through `positioned-text-web`). Its only failure is a
malformed file (a `ParseError`); it requires **no services** and writes
nothing, so a preview can never reach the write client by construction — the
whole opt-in seam rests on this.

Three obligations:

- **Stable resource keys.** `LabeledResource.key` must be stable across
  settings changes where the underlying resource is unchanged (HAR keys by
  `responseId:index`), because the reviewer's per-resource exclusions and
  inline edits are keyed by it and must survive a settings re-decode.
- **Sections are the display.** Pick a sectioning that means something to the
  reviewer: HAR sections by URL, LifeLabs by report. A section's `title` is
  the heading the shell renders.
- **Notes, not silence.** Anything the decode dropped (a response no kind
  matched, a body the archive never captured, a duplicate) becomes one note
  string, so the reviewer's opt-in stays informed.

## 2. The settings

`TSettings` is the format's per-import knobs; `defaultSettings` seeds the
shell's `FormatSettings` record. Settings are **pre-decode input**: the shell
mounts the format's `SettingsPicker` above its files in the preview, and a
change re-runs `decode` on that format's files from their retained bytes.
Anything the user should be able to change about _how_ a file decodes is a
setting — HAR's response-kind toggles (`disabledKinds`) and the LifeLabs
report time zone both live here. There is no post-decode review state besides
the shell's per-resource selection.

## 3. Persistence — nothing to write

There is no `persist` field. Every FHIR-targeting importer writes through the
shell's one shared `persistBatchBundle` (`fhir-r4/clients`), so a binding brings
no write sink and names no write client — the `FileImporterDescriptor` takes no
`R` parameter. The reviewed resources (and the source-file archive, when kept)
go out as one `POST /` batch bundle at confirm, each extracted resource stamped
with the archive's `meta.source`; the shell owns all of that.

## 4. The source archive

`sourceArchive(picked)` builds a local pick's bytes into a source-archive
`DocumentReference` — a **deterministic** id from the bytes' SHA-256 and name,
plus the upload instant, encoded through the format's archive codec — and
**returns it** (no PUT). The shell mints it once at read time, shows it in the
review as a "Source file" section (renamable, skippable), and writes it in the
same batch as the extracted resources; its logical id is what those resources
stamp onto `meta.source`. Because the id is derived from the content, re-importing
the same file under the same name upserts rather than piling up duplicates.

The codec under `src/archive/` is a thin config over
`importer-fundamentals`' shared **`sourceArchiveCodec`** — pass your coding,
content type, description prefix, and (if any) `securityLabel` as data, and
re-export only what your binding consumes: `categoryToken`, `isArchive`,
`archiveFromDocumentReference`, and the builder's `sourceArchive`. See
`har-importer-core/src/archive` / `lifelabs-pdf-importer-core/src/archive`.
You write no `source-archive.ts` of your own — `sourceArchive` comes from the
shared builder, which derives the id and mints the instant for you.

## 5. Assemble the descriptor

```ts
const myImporterDescriptor: FileImporterDescriptor<MySettings, FhirResource> = {
  format: 'my-format',
  display: { title: '…', description: '…' },
  accept: ['.myfmt', 'application/my-format'],
  detect: (bytes, fileName) => fileName.toLowerCase().endsWith('.myfmt') || myMagic(bytes),
  defaultSettings: defaultMySettings,
  decode: decodeMyFormat,
  sourceArchive,
  // the archive-read seam (re-picking uploaded archives from the server):
  archiveCategoryToken: MY_ARCHIVE_CATEGORY_TOKEN,
  isArchive: isMyArchive,
  archiveFromDocumentReference: readMyArchive,
  archiveContentType: MY_ARCHIVE_CONTENT_TYPE,
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

## 6. Register in the shell

Add the two binding packages as dependencies of `importer-react`, run
`vp install`, and extend the four registry constructs in
`importer-react/src/registry.ts`: the `FormatVariant` type-level map (the
format's `settings` / `parsed` / `requirements` triple), the `formatRegistry`
literal (the descriptor's fields plus the `SettingsPicker`), the
`defaultFormatSettings` record, and the `formatKinds` order:

```ts
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: { … },
  'lifelabs-pdf': { … },
  'my-format': {
    format: 'my-format',
    display: myImporterDescriptor.display,
    // …the descriptor's fields…
    SettingsPicker: MySettingsPicker,
  },
}
```

`BoundFormat<K>` requires every part typed against the format's
`FormatVariant` entry, so a format missing its descriptor fields or its
settings picker **fails to compile** here rather than at runtime. The shell's
per-format dispatches (`Match.type<FormatKind>()` in `use-import-run` /
`use-confirm-import`, the `if`-chain in the panel's settings form) each gain
one branch — the compiler's exhaustiveness check finds them all.

## 7. Tests per layer

Changes must include tests (see [AGENTS.md](../../../AGENTS.md) and the
`/javascript-testing-expert` command). Cover each layer where it lives:

- **Decode** — a fixture file decodes to the expected sections and notes; keys
  are stable across a settings change; a malformed file is a `ParseError`, not
  a throw.
- **Persist sink** — a failing write becomes one `PersistFailure`, not a raised
  error.
- **Settings picker** — a change reports the next settings value verbatim.
- **Shell** — the end-to-end flow: zero writes to reach a review, the confirm
  ordering (archive create before the first resource write, `meta.source` on every
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
  `FileImporterDescriptor` contract and the `Review` model.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the worked HAR
  binding this recipe generalizes.
- [lifelabs-pdf-importer-core AGENTS.md](../lifelabs-pdf-importer-core/AGENTS.md)
  — the worked document-format binding.
- [Adding a Collector How-To](../../collector/docs/Adding%20a%20Collector%20How-To.md)
  — the live-transport counterpart, whose descriptor/registry shape this mirrors.
- [Documentation Reference](../../../docs/Documentation/Reference.md) — the
  four-kinds naming this doc follows.
