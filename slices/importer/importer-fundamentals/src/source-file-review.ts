import { Effect, Either, ParseResult, Schema } from 'effect'

import type {
  DecodedFile,
  DocumentReferenceType,
  LabeledResource,
  LabeledSection,
  ReadUnit,
  UnreadableUnit,
} from './file-importer-descriptor.ts'
import { unitId } from './file-importer-descriptor.ts'
import * as MetaSource from './meta-source.ts'
import type { PickedFile } from './picked-file.ts'
import type { SourceFileCodec } from './source-file-codec.ts'
import * as SourceFileFhirReference from './source-file-fhir-reference.ts'

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
const key = (fileName: string): string => `source-file/${fileName}`

/** The section title a source file is reviewed under. */
const SECTION_TITLE = 'Source file'

/**
 * What a per-file decode learns about its file's source-file
 * `DocumentReference`: the logical id. The full
 * `DocumentReference/<id>` reference is derivable via
 * {@link SourceFileFhirReference.make}.
 */
interface Ref {
  readonly id: string
}

/**
 * A picked file's source-file reference, plus the minted resource to review
 * when there is one.
 *
 * @remarks
 * `labeled` is present for a `local` pick — the freshly minted
 * `DocumentReference`, keyed by {@link key} and titled by the file
 * name, ready for {@link withSections} — and absent for a `server`
 * pick, whose source file already exists on the server and is neither
 * re-reviewed nor re-uploaded.
 */
interface Resolved {
  readonly ref: Ref
  readonly labeled: LabeledResource<DocumentReferenceType> | undefined
}

/** The options a format can hand {@link resolve} through to the codec's mint. */
interface Options {
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
 * unavailable in an insecure context. The mint reads the clock
 * (`DateTime.now`) for the upload instant, so a settings re-decode
 * re-stamps it; the id is deterministic in the bytes and the name, so
 * the review key, the `meta.source` links, and a reviewer's edit all
 * survive the re-decode.
 */
const resolve = (
  codec: Pick<SourceFileCodec<string>, 'buildSourceFile'>,
  file: PickedFile,
  options?: Options
): Effect.Effect<Resolved, ParseResult.ParseError> => {
  if (file.source._tag === 'server') {
    const { reference } = file.source
    return Effect.succeed({
      ref: { id: SourceFileFhirReference.idOf(reference) },
      labeled: undefined,
    })
  }
  return codec.buildSourceFile(file, { subject: options?.subject }).pipe(
    Effect.flatMap((resource): Effect.Effect<Resolved, ParseResult.ParseError> => {
      const { id } = resource
      if (id === null) return Effect.fail(mintedWithoutId(file.fileName))
      return Effect.succeed({
        ref: { id },
        labeled: { key: key(file.fileName), title: file.fileName, resource },
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
const withSections = <TParsed>(
  decoded: DecodedFile<TParsed>,
  sourceFiles: readonly LabeledResource<TParsed>[]
): DecodedFile<TParsed> => {
  if (sourceFiles.length === 0) return decoded
  const sections: readonly LabeledSection<TParsed>[] = sourceFiles.map((sourceFile) => ({
    title: SECTION_TITLE,
    resources: [sourceFile],
  }))
  return { ...decoded, sections: [...sections, ...decoded.sections] }
}

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
  source: Ref
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
 * resource's `meta.source` with it, and yield one {@link ReadUnit} (in an
 * `Either.Right`) titled by the file name — or an {@link UnreadableUnit}
 * (in an `Either.Left`) carrying that file's `ParseError`, leaving the
 * batch's other files unaffected. Each unit's id is deterministic via
 * {@link unitId}.
 *
 * @typeParam TFormat - The format tag literal (e.g. `'har'`), read from the codec
 * @typeParam TSettings - The format's per-import settings
 * @typeParam TParsed - The resource type the format decodes to; the minted
 *   `DocumentReference` joins it in the result
 * @param codec - The format's source-file codec (its `buildSourceFile` and
 *   `format` tag — the tag is stamped onto each unit and used for id derivation)
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
  <TFormat extends string, TSettings, TParsed extends MetaSource.Sourceable>(
    codec: Pick<SourceFileCodec<TFormat>, 'buildSourceFile' | 'format'>,
    decodeOne: DecodeOne<TSettings, TParsed>,
    options?: PerFileDecodeOptions
  ) =>
  (
    files: readonly PickedFile[],
    settings: TSettings
  ): Effect.Effect<
    readonly Either.Either<
      ReadUnit<TParsed | DocumentReferenceType, TFormat>,
      UnreadableUnit<TFormat>
    >[]
  > =>
    Effect.forEach(
      files,
      (file) => {
        const id = unitId(codec.format, [file])
        return Effect.gen(function* () {
          const { ref, labeled } = yield* resolve(codec, file, {
            subject: options?.subjectFor?.(file),
          })
          const decoded = yield* decodeOne(file, settings, ref)
          const stamped: DecodedFile<TParsed | DocumentReferenceType> = MetaSource.stampDecoded(
            decoded,
            SourceFileFhirReference.make(ref.id)
          )
          return Either.right({
            id,
            title: file.fileName,
            files: [file] as readonly PickedFile[],
            format: codec.format,
            decoded: withSections(stamped, labeled === undefined ? [] : [labeled]),
          })
        }).pipe(
          Effect.catchAll(
            (
              error
            ): Effect.Effect<
              Either.Either<
                ReadUnit<TParsed | DocumentReferenceType, TFormat>,
                UnreadableUnit<TFormat>
              >
            > =>
              Effect.succeed(
                Either.left({
                  _tag: 'UnreadableUnit' as const,
                  id,
                  title: file.fileName,
                  files: [file] as readonly PickedFile[],
                  format: codec.format,
                  error,
                })
              )
          )
        )
      },
      { concurrency: 'unbounded' }
    )

export {
  type DecodeOne,
  type Options,
  type PerFileDecodeOptions,
  type Ref,
  type Resolved,
  SECTION_TITLE,
  key,
  perFileDecode,
  resolve,
  withSections,
}
