import { Effect, type ParseResult } from 'effect'
import type { DocumentReference } from 'fhir-r4/resources'

/**
 * A decoded FHIR R4 `DocumentReference` — the concrete type of a resource the
 * shell reads back from the FHIR server before dispatching it to one
 * descriptor's {@link FileImporterDescriptor.isSourceFile} predicate and
 * {@link FileImporterDescriptor.sourceFileFromDocumentReference} reader.
 *
 * @remarks
 * A local alias for `typeof DocumentReference.Schema.Type`, exported so
 * every consumer of the source-file seam names it the same way. `web-trace-core`
 * carries its own alias with the same shape for the trace codec; both point
 * at the same underlying `Schema.Type`, so a value satisfies either.
 */
type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * A titled resource a format binding yields from its review state — the
 * general-purpose unit the shell and the confirm step work with. The key
 * is stable across review-state changes (a kind toggle in one format must
 * not renumber resources in another), and the title is the one-line
 * display the shell shows beside each resource's include checkbox.
 *
 * @typeParam TParsed - The concrete resource type the format decodes to
 *   (FHIR for HAR and LifeLabs PDF)
 */
interface LabeledResource<TParsed> {
  readonly key: string
  readonly title: string
  readonly resource: TParsed
}

/**
 * One titled group of labeled resources a format's decode yields — the unit
 * the shell's generalized review lists. A format decides what a section is
 * from its own structure: the HAR binding sections by URL, the LifeLabs PDF
 * binding by report.
 *
 * @typeParam TParsed - The concrete resource type the format decodes to
 *   (FHIR for HAR and LifeLabs PDF)
 */
interface LabeledSection<TParsed> {
  readonly title: string
  readonly resources: readonly LabeledResource<TParsed>[]
}

/**
 * Everything one file's decode yields for review: the titled sections of
 * labeled resources the shell renders with per-resource include/edit, and
 * the file-level diagnostic notes for what did not become a resource (a
 * response no kind matched, a body the archive dropped) — surfaced so the
 * reviewer's opt-in stays informed, folded to data so decode stays total
 * past the one malformed-file `ParseError`.
 *
 * @typeParam TParsed - The concrete resource type the format decodes to
 */
interface DecodedFile<TParsed> {
  readonly sections: readonly LabeledSection<TParsed>[]
  readonly notes: readonly string[]
}

/**
 * Every labeled resource across a decoded file's sections, in section order —
 * the flat list the per-resource `StagedImport` transitions and the confirm's
 * write set fold over.
 *
 * @param sections - A decoded file's sections
 * @returns The sections' resources concatenated, order preserved
 */
const sectionResources = <TParsed>(
  sections: readonly LabeledSection<TParsed>[]
): readonly LabeledResource<TParsed>[] => sections.flatMap((section) => section.resources)

/**
 * The props a format's settings picker receives — the current settings and a
 * way to change them. Generic over the format's `TSettings` so each picker is
 * written against its own precise shape, mirroring the collector slice's
 * `ConfigFormProps`.
 *
 * @remarks
 * Declared here — below every format's React package — so a format UI
 * implements it without reaching into a sibling format's package. A plain
 * props record, no React types: the picker component shape lives where the
 * components do.
 */
interface SettingsPickerProps<TSettings> {
  /** The current settings value. */
  readonly settings: TSettings
  /** Called with the next settings when the user changes them. */
  readonly onChange: (settings: TSettings) => void
}

/**
 * The minimal file shape the descriptor's batch decode receives — file name
 * plus raw bytes. The shell's `PickedFile` satisfies this structurally, so
 * the descriptor never names the shell's type.
 */
interface PickedFileLike {
  readonly fileName: string
  readonly bytes: Uint8Array
}

/**
 * One decoded unit a batch decode produces: the input files the format
 * grouped into this unit, and the decoded sections + notes for them. A
 * single-file format returns one unit per input file; a group format
 * (e.g. DICOM study) may merge several files into fewer units.
 *
 * @typeParam TParsed - The concrete resource type the format decodes to
 */
interface DecodedUnit<TParsed> {
  readonly files: readonly PickedFileLike[]
  readonly decoded: DecodedFile<TParsed>
}

/**
 * "A file-format importer" as one first-class value: everything the shell needs
 * to turn a picked file of one format into reviewed, opt-in-written resources —
 * resource-agnostic and format-agnostic in this package, bound to a concrete
 * format and resource type in its own `*-importer-core` package.
 *
 * @typeParam TSettings - The format's per-import settings (the kind toggles
 *   for HAR, the report time zone for LifeLabs PDF); the shell seeds a form
 *   from {@link defaultSettings} and hands the chosen settings to
 *   {@link decode}, re-decoding a file when its format's settings change
 * @typeParam TParsed - The resource type this format decodes to (FHIR for HAR
 *   and LifeLabs PDF)
 *
 * @remarks
 * The format core owns the whole decode; the general shell sees only the
 * {@link DecodedFile} — titled sections of {@link LabeledResource}s plus
 * diagnostic notes — and renders one per-resource exclude/edit review over
 * it, with no format-specific review UI. Persistence of the reviewed FHIR
 * resources themselves is *not* the format's job: every FHIR-targeting
 * importer writes through the shared `persistBatchBundle` in
 * `fhir-r4/clients` at the shell (see `use-confirm-import.ts` in
 * `importer-react`), so no format can bring its own persistence approach —
 * dropped after HAR and LifeLabs proved to share a verbatim identical
 * `withMetaSource → persistResources` sink. No field on the descriptor
 * requires a write client: {@link decode} and {@link buildSourceFile} are both
 * pure, so a preview can never reach the write client by construction, and
 * the source-file `DocumentReference` rides the same reviewed batch as the
 * extracted resources rather than a private upload of its own.
 */
interface FileImporterDescriptor<TSettings, TParsed> {
  /** The format tag this descriptor binds (`'har'`, `'lifelabs-pdf'`); the registry's key. */
  readonly format: string
  /** User-facing strings the shell shows for this format. */
  readonly display: { readonly title: string; readonly description: string }
  /**
   * Cheap syntactic identification: whether these bytes plausibly hold this
   * format, by file extension or by magic bytes. Not a parse — the picker
   * tries every registered descriptor's `detect` on every drop, so a full
   * parse here would run every format's parser on every pick. First
   * descriptor whose `detect` claims a file wins; register the crispest
   * (magic bytes) ahead of the loosest (extension sniff).
   */
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  /** A valid settings value to seed a fresh import's settings form. */
  readonly defaultSettings: TSettings
  /**
   * Decode a batch of picked files into one {@link DecodedUnit} per group
   * the format decides on. Single-file formats use {@link perFileDecode} to
   * wrap their existing per-file decode; a group format (e.g. a DICOM study
   * that merges several `.dcm` files) may merge several files into fewer
   * units. The only failure is a malformed file (a `ParseError`); it
   * requires no services and writes nothing.
   *
   * @remarks
   * Bytes rather than text so the seam stays format-blind: a HAR decodes
   * UTF-8 JSON, a PDF decodes binary. A format that reads text decodes
   * (`new TextDecoder().decode(bytes)`) at the top of its own `decode`.
   * Resource keys must be stable across settings changes where the
   * underlying resource is unchanged, so a re-decode under new settings
   * keeps the reviewer's per-resource exclusions and edits applying.
   * `fileName` is passed alongside the bytes so a format whose synthesized
   * resources need to reference the file's own source-file `DocumentReference`
   * (DICOM's ImagingStudy instance does) can recompute that document's
   * deterministic id, which is derived from the bytes' digest and this same
   * name — see `buildSourceFile` in `source-file-codec.ts`.
   */
  readonly decode: (
    files: readonly PickedFileLike[],
    settings: TSettings
  ) => Effect.Effect<readonly DecodedUnit<TParsed>[], ParseResult.ParseError>
  /**
   * Build a local pick's bytes into a source-file `DocumentReference` —
   * the resource that carries the raw file whole, so a reader can trace an
   * imported resource back to the source it came from. Pure: it mints a
   * fresh id, hashes the bytes, and returns the resource, but writes
   * nothing.
   *
   * @remarks
   * The shell mints this once per local pick at read time and shows it in
   * the review as its own "Source file" section, so the reviewer can rename
   * it (edit the JSON) or skip uploading it (exclude it) like any other
   * resource. On confirm it rides the *same* `persistBatchBundle` as the
   * extracted resources — one bundle, not a private upload — and its logical
   * id is what those resources stamp onto `meta.source` (stripped when the
   * source file is excluded). Each format builds with its own source-file
   * codec, so the resource always round-trips through the matching
   * {@link sourceFileFromDocumentReference} reader.
   *
   * A server pick is not this seam's concern — its source file already
   * exists on the server and its reference is on the pick — so this only
   * ever runs for a `local` pick and receives its bytes verbatim. The
   * source file is always a FHIR `DocumentReference` regardless of
   * `TParsed`; both formats decode to FHIR and persist through the FHIR
   * batch sink. Fails only as a `ParseError`, the way the source-file
   * codec's encode does (a digest unavailable in an insecure context).
   */
  readonly buildSourceFile: (
    picked: {
      readonly fileName: string
      readonly bytes: Uint8Array
    },
    options?: { readonly subject?: { readonly reference: string } }
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
  /**
   * FHIR `category` search token — `system|code` form — every server-side
   * source-file read filters on for this format's uploaded source files.
   * The one spelling of the token, sourced from the format's `/source-file`
   * codec so a downstream reader cannot drift from what the codec writes.
   *
   * @remarks
   * The shell unions every registered format's token into one comma-joined
   * `category=t1,t2,...` search, so listing "every uploaded source file on
   * the FHIR server" needs no per-format query. Cannot be `undefined`: the
   * format has a corresponding source-file codec (the
   * {@link buildSourceFile} writes with it, the
   * {@link sourceFileFromDocumentReference} reads with it) — this is that
   * same coding, promoted to a search token.
   */
  readonly sourceFileCategoryToken: string
  /**
   * Whether a decoded `DocumentReference` is a source file of *this*
   * format, by `category`. The predicate every row is classified through:
   * the comma-joined server search returns rows for every registered
   * format, and each row is tagged with the descriptor whose
   * `isSourceFile` claims it.
   *
   * @remarks
   * Source-file predicates are disjoint across formats by construction —
   * `isHarSourceFile` tests `WEB_TRACE_CODE_SYSTEM|har-archive`,
   * `isLifeLabsPdfSourceFile` tests
   * `LIFELABS_SYSTEM|lifelabs-pdf-archive` — so exactly one predicate
   * claims any given row. A row no predicate claims is dropped by the
   * shell (the coding matched the token search but the resource is not
   * from a registered format).
   */
  readonly isSourceFile: (resource: DocumentReferenceType) => boolean
  /**
   * Reads a decoded source-file `DocumentReference` back as its bytes and
   * file name. The seam a preview modal calls to render the raw source
   * file, and the same reader `fetchSourceFile` uses to re-hydrate a
   * picked source file into its `PickedFile` bytes.
   *
   * @remarks
   * Returns bytes rather than text so a PDF source file round-trips
   * verbatim (a UTF-8 round trip would mangle it) and a HAR source file
   * keeps its original byte-level content for hashing. Requires nothing (a
   * preview or a pick reads the resource the FHIR server already returned),
   * and fails only as a `ParseError` when the resource does not match this
   * format's source-file shape — a caller dispatches on
   * {@link isSourceFile} first, so the failure is the "coding matched but
   * the resource is malformed" case, not the "wrong format" case.
   */
  readonly sourceFileFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<
    { readonly fileName: string; readonly bytes: Uint8Array },
    ParseResult.ParseError
  >
  /**
   * The MIME type of this format's source-file attachment
   * (`'application/json'` for HAR, `'application/pdf'` for LifeLabs PDF).
   * Drives the preview modal's renderer choice — a PDF renders in an
   * `<iframe>` from a `blob:` URL, JSON pretty-prints inside a `<pre>`.
   *
   * @remarks
   * The source-file codec's own content-type constant, promoted to the
   * descriptor so the shell needs no format-specific dispatch to pick a
   * renderer.
   */
  readonly sourceFileContentType: string
}

/**
 * The first registered descriptor whose {@link FileImporterDescriptor.detect}
 * claims the picked bytes, or `undefined` when none does.
 *
 * @param descriptors - The registry's descriptors, in registry order
 * @param file - The picked file to identify, as name plus bytes
 * @returns The claiming descriptor, or `undefined`
 *
 * @remarks
 * First match wins, so registry order is priority order — put formats with
 * crisp magic-byte tests (PDF's `%PDF-`) ahead of looser syntactic ones.
 * Generic over anything descriptor-shaped rather than over
 * {@link FileImporterDescriptor} itself so the shell can route bound
 * (descriptor + adapters) records through it.
 */
const identify = <D extends Pick<FileImporterDescriptor<never, never>, 'detect'>>(
  descriptors: readonly D[],
  file: { readonly fileName: string; readonly bytes: Uint8Array }
): D | undefined => descriptors.find((descriptor) => descriptor.detect(file.bytes, file.fileName))

/**
 * Wrap a single-file decode function into the batch {@link FileImporterDescriptor.decode}
 * shape: each input file is decoded independently, producing one
 * {@link DecodedUnit} per file. The helper that single-file formats
 * (`har`, `lifelabs-pdf`, `dicom`) use so their existing per-file decode
 * needs no structural change.
 */
const perFileDecode =
  <TSettings, TParsed>(
    decodeFn: (
      fileBytes: Uint8Array,
      settings: TSettings
    ) => Effect.Effect<DecodedFile<TParsed>, ParseResult.ParseError>
  ): ((
    files: readonly PickedFileLike[],
    settings: TSettings
  ) => Effect.Effect<readonly DecodedUnit<TParsed>[], ParseResult.ParseError>) =>
  (files, settings) =>
    Effect.forEach(
      files,
      (file) =>
        decodeFn(file.bytes, settings).pipe(
          Effect.map((decoded): DecodedUnit<TParsed> => ({ files: [file], decoded }))
        ),
      { concurrency: 'unbounded' }
    )

/**
 * The stable review key for a file's source-file archive, scoped by file
 * name so two files in one batch never collide on their source-file keys.
 */
const sourceFileKey = (fileName: string): string => `source-file/${fileName}`

export { identify, perFileDecode, sourceFileKey, sectionResources }
export type {
  DecodedFile,
  DecodedUnit,
  DocumentReferenceType,
  FileImporterDescriptor,
  LabeledResource,
  LabeledSection,
  PickedFileLike,
  SettingsPickerProps,
}
