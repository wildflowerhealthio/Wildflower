import { Effect, ParseResult, Schema } from 'effect'
import type { Meta } from 'fhir-r4/data-types'

import type {
  DecodedFile,
  DecodedUnit,
  DecodeOutcome,
  DocumentReferenceType,
  LabeledResource,
  LabeledSection,
} from './file-importer-descriptor.ts'
import { type PickedFile, sourceFileIdOf, sourceFileReference } from './picked-file.ts'
import type { SourceFileCodec } from './source-file-codec.ts'

/**
 * The generic pieces every format composes to own its source-file
 * `DocumentReference` inside `decode`: resolve a picked file's source
 * reference (minting the resource for a `local` pick), list it as its own
 * reviewable "Source file" section, and stamp `meta.source` onto the
 * extracted resources. {@link perFileDecode} strings them together for a
 * single-file format; a group format calls them itself, per file.
 *
 * @remarks
 * Nothing here is format-specific: a format passes its own source-file
 * codec (the `buildSourceFile` that names its coding) and its own per-file
 * decode, and gets back a `decode` in the descriptor's batch shape. Living
 * here — below every binding and above the codec — is what lets the shell
 * carry no source-file knowledge at all: what a source file is, which
 * resources point at it, and what happens to those links is each format's
 * decision, expressed through these helpers.
 *
 * @packageDocumentation
 */

/**
 * The stable review key for a file's source-file resource, scoped by file
 * name so two files in one unit never collide.
 *
 * @param fileName - The picked file's name
 * @returns `source-file/<fileName>`
 */
const sourceFileKey = (fileName: string): string => `source-file/${fileName}`

/** The section title a source file is reviewed under. */
const SOURCE_SECTION_TITLE = 'Source file'

/**
 * What a per-file decode learns about its file's source-file
 * `DocumentReference`, local or server: the logical id and the
 * `DocumentReference/<id>` reference every extracted resource stamps onto
 * `meta.source`.
 */
interface SourceFileRef {
  readonly id: string
  readonly reference: string
}

/**
 * A picked file's source-file reference, plus the minted resource to review
 * when there is one.
 *
 * @remarks
 * `labeled` is present for a `local` pick — the freshly minted
 * `DocumentReference`, keyed by {@link sourceFileKey} and titled by the file
 * name, ready for {@link withSourceSections} — and absent for a `server`
 * pick, whose source file already exists on the server and is neither
 * re-reviewed nor re-uploaded.
 */
interface ResolvedSourceFile {
  readonly ref: SourceFileRef
  readonly labeled: LabeledResource<DocumentReferenceType> | undefined
}

/** The options a format can hand {@link sourceFileFor} through to the codec's mint. */
interface SourceFileOptions {
  /** A `subject` to link the minted resource to (DICOM derives a Patient from its header). */
  readonly subject?: { readonly reference: string } | undefined
}

/**
 * Resolve a picked file's source-file `DocumentReference`: mint it for a
 * `local` pick through the format's codec, or take the existing reference
 * off a `server` pick.
 *
 * @param codec - The format's source-file codec — only its `buildSourceFile`
 * @param file - The picked file, with its provenance
 * @param options - Passed through to the mint; a `subject` to link
 * @returns The reference (and id) plus, for a `local` pick, the minted
 *   resource as a labeled review row
 *
 * @remarks
 * Fails only as the codec's mint does — a `ParseError` for a digest
 * unavailable in an insecure context — or when a `server` reference is not
 * a `DocumentReference/<id>` (a malformed pick, folded to the same channel
 * so a caller has one failure to handle). The mint reads the clock
 * (`DateTime.now`) for the upload instant, so a settings re-decode
 * re-stamps it; the id is deterministic in the bytes and the name, so
 * the review key, the `meta.source` links, and a reviewer's edit all
 * survive the re-decode.
 */
const sourceFileFor = (
  codec: Pick<SourceFileCodec, 'buildSourceFile'>,
  file: PickedFile,
  options?: SourceFileOptions
): Effect.Effect<ResolvedSourceFile, ParseResult.ParseError> => {
  if (file.source._tag === 'server') {
    const { reference } = file.source
    const id = sourceFileIdOf(reference)
    if (id === undefined) return Effect.fail(notASourceFileReference(reference))
    return Effect.succeed({ ref: { id, reference }, labeled: undefined })
  }
  return codec.buildSourceFile(file, { subject: options?.subject }).pipe(
    Effect.flatMap((resource): Effect.Effect<ResolvedSourceFile, ParseResult.ParseError> => {
      // The codec mints the id, so a null here is a broken codec rather than
      // an input the format can do anything with — but the schema types the
      // field nullable, and a link to nothing is worse than no link.
      const { id } = resource
      if (id === null) return Effect.fail(mintedWithoutId(file.fileName))
      return Effect.succeed({
        ref: { id, reference: sourceFileReference(id) },
        labeled: { key: sourceFileKey(file.fileName), title: file.fileName, resource },
      })
    })
  )
}

/** A minted source file the codec left id-less. */
const mintedWithoutId = (fileName: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Type(
      Schema.String.ast,
      fileName,
      `Source file minted without an id: ${fileName}`
    ),
  })

/** A `server` pick whose reference does not name a `DocumentReference`. */
const notASourceFileReference = (reference: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Type(
      Schema.String.ast,
      reference,
      `Not a DocumentReference reference: ${reference}`
    ),
  })

/**
 * Prepend one "Source file" section per labeled source file ahead of a
 * decoded file's own sections, so the generalized review lists each source
 * file like any other resource. A decode with no source files (every file a
 * `server` pick) is returned unchanged.
 *
 * @typeParam TParsed - The decoded resource type; the source-file
 *   `DocumentReference` must be a member of it (it is, for every FHIR format)
 * @param decoded - The format's own sections and notes
 * @param sourceFiles - The labeled source files, in file order
 * @returns The decoded file with the source-file sections prepended
 */
const withSourceSections = <TParsed>(
  decoded: DecodedFile<TParsed>,
  sourceFiles: readonly LabeledResource<TParsed>[]
): DecodedFile<TParsed> => {
  if (sourceFiles.length === 0) return decoded
  const sections: readonly LabeledSection<TParsed>[] = sourceFiles.map((sourceFile) => ({
    title: SOURCE_SECTION_TITLE,
    resources: [sourceFile],
  }))
  return { ...decoded, sections: [...sections, ...decoded.sections] }
}

/**
 * The minimum a resource must expose to carry a `meta.source` link: the
 * `meta` slot the back-link is written into.
 *
 * @remarks
 * Structural rather than the `FhirResource` union, so a format whose
 * decode produces a narrower type keeps that type through the stamp. The
 * same shape `web-trace-core`'s provenance helper uses; a copy rather than
 * an import, since this package must not depend on that slice.
 */
interface MetaSourceable {
  readonly meta: typeof Meta.Schema.Type | null
}

/**
 * Set `meta.source` on a resource, preserving whatever else its `meta`
 * carried.
 *
 * @param resource - The resource to link
 * @param source - The relative reference of the source file that produced it
 * @returns The resource with `meta.source` set
 *
 * @remarks
 * FHIR's `meta.source` is one `uri`, so a resource decoded from several
 * files (a group format's study-level resource) can name only one of them
 * here — which one is the format's decision.
 */
const withMetaSource = <TResource extends MetaSourceable>(
  resource: TResource,
  source: string
): TResource => ({
  ...resource,
  meta: {
    lastUpdated: null,
    profile: [],
    security: [],
    tag: [],
    versionId: null,
    ...resource.meta,
    source,
  },
})

/**
 * Stamp `meta.source` onto every resource in every section of a decoded
 * file, leaving titles, keys, and notes untouched.
 *
 * @param decoded - The format's own sections and notes
 * @param source - The reference every resource is stamped with
 * @returns The same sections with each resource linked
 */
const stampMetaSource = <TParsed extends MetaSourceable>(
  decoded: DecodedFile<TParsed>,
  source: string
): DecodedFile<TParsed> => ({
  ...decoded,
  sections: decoded.sections.map((section) => ({
    ...section,
    resources: section.resources.map((entry) => ({
      ...entry,
      resource: withMetaSource(entry.resource, source),
    })),
  })),
})

/**
 * A single-file format's per-file decode: the picked file, the settings the
 * import runs under, and the file's resolved source-file reference — so a
 * format whose synthesized resources need the source file's own id (DICOM's
 * `ImagingStudy` instance names it) reads it here rather than recomputing
 * it.
 */
type DecodeOne<TSettings, TParsed> = (
  file: PickedFile,
  settings: TSettings,
  source: SourceFileRef
) => Effect.Effect<DecodedFile<TParsed>, ParseResult.ParseError>

/** The per-format knobs {@link perFileDecode} takes beside the codec and the decode. */
interface PerFileDecodeOptions {
  /**
   * The `subject` the minted source file links to, derived per file (DICOM
   * reads a Patient out of the header). `undefined` leaves the resource
   * without one — the default, which keeps an engineering artifact out of
   * `Patient/$everything`.
   */
  readonly subjectFor?: (file: PickedFile) => { readonly reference: string } | undefined
}

/**
 * Lift a single-file decode into the descriptor's batch `decode`: for each
 * picked file, resolve its source file, run `decodeOne`, list the minted
 * source file as its own "Source file" section, stamp every extracted
 * resource's `meta.source` with it, and yield one `read` unit titled by the
 * file name — or an `unreadable` unit carrying that file's `ParseError`,
 * leaving the batch's other files unaffected.
 *
 * @typeParam TSettings - The format's per-import settings
 * @typeParam TParsed - The resource type the format decodes to; the minted
 *   `DocumentReference` joins it in the result
 * @param codec - The format's source-file codec (its `buildSourceFile`)
 * @param decodeOne - The format's per-file decode
 * @param options - Per-file knobs, see {@link PerFileDecodeOptions}
 * @returns A batch `decode` in the {@link FileImporterDescriptor} shape
 *
 * @remarks
 * Files decode concurrently and the outcomes come back in pick order. A
 * `server` pick mints nothing and gets no "Source file" section; its
 * resources are stamped with the pick's existing reference.
 */
const perFileDecode =
  <TSettings, TParsed extends MetaSourceable>(
    codec: Pick<SourceFileCodec, 'buildSourceFile'>,
    decodeOne: DecodeOne<TSettings, TParsed>,
    options?: PerFileDecodeOptions
  ) =>
  (
    files: readonly PickedFile[],
    settings: TSettings
  ): Effect.Effect<readonly DecodeOutcome<TParsed | DocumentReferenceType>[]> =>
    Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const { ref, labeled } = yield* sourceFileFor(codec, file, {
            subject: options?.subjectFor?.(file),
          })
          const decoded = yield* decodeOne(file, settings, ref)
          const stamped: DecodedFile<TParsed | DocumentReferenceType> = stampMetaSource(
            decoded,
            ref.reference
          )
          return {
            _tag: 'read',
            title: file.fileName,
            files: [file],
            decoded: withSourceSections(stamped, labeled === undefined ? [] : [labeled]),
          } satisfies DecodedUnit<TParsed | DocumentReferenceType>
        }).pipe(
          Effect.catchAll((error): Effect.Effect<DecodeOutcome<TParsed | DocumentReferenceType>> =>
            Effect.succeed({ _tag: 'unreadable', title: file.fileName, files: [file], error })
          )
        ),
      { concurrency: 'unbounded' }
    )

export {
  type DecodeOne,
  type MetaSourceable,
  type PerFileDecodeOptions,
  perFileDecode,
  type ResolvedSourceFile,
  SOURCE_SECTION_TITLE,
  type SourceFileOptions,
  type SourceFileRef,
  sourceFileFor,
  sourceFileKey,
  stampMetaSource,
  withMetaSource,
  withSourceSections,
}
