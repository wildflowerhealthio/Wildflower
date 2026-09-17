import type { Effect, Either, ParseResult } from 'effect'
import type { DocumentReference, FhirResource } from 'fhir-r4/resources'

import type { PickedFile } from './picked-file.ts'
import type { SourceFileCodec } from './source-file-codec.ts'

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
 * Deterministic unit identity derived from the format tag and the file
 * names the unit was decoded from. Stable across settings re-decodes
 * because the inputs are the same, so the reviewer's selection map (keyed
 * by unit id) survives without external id-preservation logic.
 *
 * @param format - The format tag (`'har'`, `'lifelabs-pdf'`, etc.)
 * @param files - The picked files the unit was decoded from
 * @returns A stable, human-readable id
 */
const unitId = (format: string, files: readonly PickedFile[]): string =>
  `${format}/${files.map((f) => f.fileName).join(',')}`

/**
 * One unit the batch read decoded successfully, stamped with a stable id
 * and the format that claimed it. Lives in the `Right` of an
 * `Either`-valued batch outcome; discrimination is via `Either.isRight`.
 *
 * @typeParam TFormat - The format tag (e.g. `FormatKind` in the registry)
 *
 * @remarks
 * A single-file format returns one unit per input file, titled by the file
 * name; a group format (a DICOM study spanning several `.dcm` files) may
 * merge several files into fewer units and title them by what the group is.
 * `id` is a per-unit stable identity for a React `key` and for the
 * reviewer's selection map — it survives a settings re-decode.
 */
interface ReadUnit<TFormat extends string> {
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
  readonly format: TFormat
  readonly decoded: DecodedFile<FhirResource>
}

/**
 * A unit whose format was identified but whose decode rejected the bytes —
 * the malformed-input case, folded to data so a batch decode never fails as
 * a whole. Tagged for discrimination against other error variants (e.g.
 * `UnrecognizedFile`) in the `Left` of an `Either`-valued batch outcome.
 *
 * @typeParam TFormat - The format tag (e.g. `FormatKind` in the registry)
 */
interface UnreadableUnit<TFormat extends string> {
  readonly _tag: 'UnreadableUnit'
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
  readonly format: TFormat
  readonly error: ParseResult.ParseError
}

/**
 * "A file-format importer" as one first-class value: everything the shell
 * needs to turn a picked file of one format into reviewed, opt-in-written
 * resources. Each format binding (`har-importer-core`, etc.) instantiates
 * one; the registry lists them.
 *
 * @typeParam TFormat - The format tag literal (`'har'`, `'lifelabs-pdf'`, etc.)
 * @typeParam TSettings - The format's per-import settings
 *
 * @remarks
 * The source-file codec is encapsulated: the shell reads the category
 * token, the `isSourceFile` predicate, the read-back function, and the
 * content type through accessors, and never sees the codec's schemas, wire
 * builder, or `buildSourceFile`. `perFileDecode` receives the codec at
 * construction time (before this class is instantiated), so the decode
 * function closes over it without exposing it.
 */
class FileImporter<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  readonly decode: (
    files: readonly PickedFile[],
    settings: TSettings
  ) => Effect.Effect<readonly Either.Either<ReadUnit<TFormat>, UnreadableUnit<TFormat>>[]>

  protected readonly codec: SourceFileCodec<TFormat>

  constructor(config: {
    readonly codec: SourceFileCodec<TFormat>
    readonly display: { readonly title: string; readonly description: string }
    readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
    readonly defaultSettings: TSettings
    readonly decode: (
      files: readonly PickedFile[],
      settings: TSettings
    ) => Effect.Effect<readonly Either.Either<ReadUnit<TFormat>, UnreadableUnit<TFormat>>[]>
  }) {
    this.codec = config.codec
    this.format = config.codec.format
    this.display = config.display
    this.detect = config.detect
    this.defaultSettings = config.defaultSettings
    this.decode = config.decode
  }

  get categoryToken(): string {
    return this.codec.categoryToken
  }

  get contentType(): string {
    return this.codec.contentType
  }

  isSourceFile(resource: DocumentReferenceType): boolean {
    return this.codec.isSourceFile(resource)
  }

  sourceFileFromDocumentReference(
    resource: DocumentReferenceType
  ): Effect.Effect<
    { readonly id: string; readonly fileName: string; readonly bytes: Uint8Array },
    ParseResult.ParseError
  > {
    return this.codec.sourceFileFromDocumentReference(resource)
  }
}

/**
 * The first registered importer whose `detect` claims the picked bytes, or
 * `undefined` when none does.
 *
 * @remarks
 * First match wins, so registry order is priority order — put formats with
 * crisp magic-byte tests (PDF's `%PDF-`) ahead of looser syntactic ones.
 */
const identify = <D extends Pick<FileImporter<string, never>, 'detect'>>(
  descriptors: readonly D[],
  file: { readonly fileName: string; readonly bytes: Uint8Array }
): D | undefined => descriptors.find((descriptor) => descriptor.detect(file.bytes, file.fileName))

export { FileImporter, identify, sectionResources, unitId }
export type {
  DecodedFile,
  DocumentReferenceType,
  LabeledResource,
  LabeledSection,
  ReadUnit,
  SettingsPickerProps,
  UnreadableUnit,
}
