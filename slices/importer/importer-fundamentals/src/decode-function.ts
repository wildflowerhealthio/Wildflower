import { Effect, Either, type ParseResult } from 'effect'
import { type DocumentReference } from 'fhir-r4/resources'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * What {@link fromCombinableDecodeConfig} needs of a format: its tag, its per-file decode, and
 * — when it files its source file under a subject — its `subjectFor`.
 *
 * @remarks
 * A `FileImporterConfig` nests one of these as its `decodeFunctionConfig`, so a
 * binding writes the shape this module reads and `fileImporter` hands it
 * straight through. It is also where the format tag is declared, once — the
 * importer's own `format` is read back off it.
 *
 * The source-file operations are not parameters: this
 * module calls `SourceFile.tryFromNamedBytes` and `SourceFile.encodeSourceFile`
 * directly, unbound, so the decode it builds still carries the
 * `SourceFile.FormatContext` requirement for `fileImporter` to discharge in one
 * place.
 */
interface CombinableDecodeConfig<TFormat extends string, TSettings>
  extends SourceFile.PerFileDecodeOptions {
  readonly format: TFormat
  /**
   * One format's per-file decode step, given the file, its settings, and the
   * reference to the source file every resource it yields will be stamped with —
   * minted for a `local` pick, the existing one for a `server` pick.
   */
  readonly decodeOne: (
    file: PickedFile.PickedFile,
    settings: TSettings,
    sourceFile: SourceFile.Reference
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>
}

/**
 * What one file resolved to before its decode ran.
 *
 * @remarks
 * A `local` pick's source file is minted here but built *after* the decode, so
 * it can be filed under the subject `subjectFor` reads off the decode's own
 * resources. `mintResource` is that deferred build — `undefined` for a `server`
 * pick, whose resource is already stored.
 */
interface ResolvedSource {
  readonly reference: SourceFile.Reference
  readonly mintResource:
    | ((
        subject: SourceFile.Subject | undefined
      ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError, SourceFile.FormatContext>)
    | undefined
}

const resolveSource = (
  file: PickedFile.PickedFile
): Effect.Effect<ResolvedSource, ParseResult.ParseError, SourceFile.FormatContext> => {
  if (file.source._tag === 'server') {
    return Effect.succeed({ reference: file.source.reference, mintResource: undefined })
  }
  return SourceFile.tryFromNamedBytes(file).pipe(
    Effect.map((sourceFile) => ({
      reference: SourceFile.makeReference(sourceFile.id),
      mintResource: (subject: SourceFile.Subject | undefined) =>
        SourceFile.encodeSourceFile(sourceFile, subject),
    }))
  )
}

/**
 * Lift one format's per-file `decodeOne` into the batch `decode` the shell
 * runs: one file at a time, each contributing its own "Source file" row, its
 * sections under its own key namespace, and its own unreadable row when it
 * rejects.
 *
 * @param config - The format's tag, per-file decode, and optional `subjectFor`
 * @returns The format's batch `decode`, which never fails, still needing its `SourceFile.FormatContext`
 */
const fromCombinableDecodeConfig =
  <TFormat extends string, TSettings>(
    config: CombinableDecodeConfig<TFormat, TSettings>,
    sourceFileFormat: SourceFile.Format
  ): Type<TSettings, TFormat> =>
  (
    files: readonly PickedFile.PickedFile[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>, never> =>
    Effect.forEach(
      files,
      (file, index) => {
        const prefix = FormatDecode.keyPrefix(index, file)
        return Effect.gen(function* () {
          const { reference, mintResource } = yield* resolveSource(file)
          const decoded = yield* config.decodeOne(file, settings, reference)
          const stamped = MetaSource.stampDecoded(
            DecodedFile.namespaceKeys(decoded, prefix),
            reference
          )
          if (mintResource === undefined) return Either.right(stamped)
          const resource = yield* mintResource(config.subjectFor?.(file, decoded))
          return Either.right(
            SourceFile.prependToDecodedFile(stamped, {
              key: `${prefix}${SourceFile.key(file.fileName)}`,
              title: file.fileName,
              resource,
            })
          )
        }).pipe(
          Effect.catchAll(
            (
              error
            ): Effect.Effect<Either.Either<DecodedFile.DecodedFile, FormatDecode.UnreadableFile>> =>
              Effect.succeed(
                Either.left({
                  id: FormatDecode.makeFileId(config.format, index, file),
                  title: file.fileName,
                  pickedFile: file,
                  error,
                })
              )
          )
        )
      },
      { concurrency: 'unbounded' }
    ).pipe(
      Effect.map((results): FormatDecode.Result<TFormat> => {
        const sections: DecodedFile.Section[] = []
        const notes: string[] = []
        const unreadableFiles: FormatDecode.UnreadableFile[] = []
        for (const result of results) {
          Either.match(result, {
            onLeft: (failure) => unreadableFiles.push(failure),
            onRight: (decoded) => {
              sections.push(...decoded.sections)
              notes.push(...decoded.notes)
            },
          })
        }
        return {
          id: FormatDecode.makeId(config.format, files),
          title: files.map((f) => f.fileName).join(', '),
          files,
          format: config.format,
          decoded: { sections, notes },
          unreadableFiles,
        }
      }),
      Effect.provideService(SourceFile.FormatContext, sourceFileFormat)
    )

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing.
 *
 * @remarks
 * `R` is spelled at every use. A decode a `FileImporter` exposes is bound —
 * `Type<TSettings, TFormat, never>`; one still to be bound, as
 * {@link fromCombinableDecodeConfig} returns, is
 * `Type<TSettings, TFormat, SourceFile.FormatContext>`.
 */
type Type<in TSettings, TFormat extends string> = WithContext<TSettings, TFormat, never>

type WithContext<in TSettings, TFormat extends string, R> = (
  files: readonly PickedFile.PickedFile[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never, R>

export { fromCombinableDecodeConfig }
export type { CombinableDecodeConfig, Type, WithContext }
