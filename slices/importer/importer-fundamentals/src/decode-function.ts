import { Effect, Either, type ParseResult } from 'effect'
import { type DocumentReference } from 'fhir-r4/resources'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * The two source-file operations {@link fromProvider} drives.
 *
 * @remarks
 * Both still carry the `SourceFile.FormatContext` requirement: the decode built
 * here is bound by `fileImporter`, in one place, rather than by each operation
 * on the way in.
 */
interface SourceFileMint {
  readonly mintSourceFile: (
    picked: PickedFile.NamedBytes
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError, SourceFile.FormatContext>
  readonly sourceFileToDocumentReference: (
    sourceFile: SourceFile.Type,
    subject?: SourceFile.Subject
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError, SourceFile.FormatContext>
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
  mint: SourceFileMint,
  file: PickedFile.PickedFile
): Effect.Effect<ResolvedSource, ParseResult.ParseError, SourceFile.FormatContext> => {
  if (file.source._tag === 'server') {
    return Effect.succeed({ reference: file.source.reference, mintResource: undefined })
  }
  return mint.mintSourceFile(file).pipe(
    Effect.map((sourceFile) => ({
      reference: SourceFile.makeReference(sourceFile.id),
      mintResource: (subject: SourceFile.Subject | undefined) =>
        mint.sourceFileToDocumentReference(sourceFile, subject),
    }))
  )
}

/**
 * Lift one format's per-file `decodeOne` into the batch `decode` the shell
 * runs: one file at a time, each contributing its own "Source file" row, its
 * sections under its own key namespace, and its own unreadable row when it
 * rejects.
 *
 * @param provider - The format tag and the source-file mint the rows come from
 * @param decodeOne - The format's per-file decode
 * @param options - `subjectFor`, when the format files its source file under a subject
 * @returns The format's batch `decode`, which never fails, still needing its `SourceFile.FormatContext`
 */
const fromProvider =
  <TFormat extends string, TSettings>(
    provider: SourceFileMint & { readonly format: TFormat },
    decodeOne: SourceFile.DecodeOne<TSettings>,
    options?: SourceFile.PerFileDecodeOptions
  ): WithContext<TSettings, TFormat, SourceFile.FormatContext> =>
  (
    files: readonly PickedFile.PickedFile[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>, never, SourceFile.FormatContext> =>
    Effect.forEach(
      files,
      (file, index) => {
        const prefix = FormatDecode.keyPrefix(index, file)
        return Effect.gen(function* () {
          const { reference, mintResource } = yield* resolveSource(provider, file)
          const decoded = yield* decodeOne(file, settings, reference)
          const stamped = MetaSource.stampDecoded(
            DecodedFile.namespaceKeys(decoded, prefix),
            reference
          )
          if (mintResource === undefined) return Either.right(stamped)
          const resource = yield* mintResource(options?.subjectFor?.(file, decoded))
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
                  id: FormatDecode.makeFileId(provider.format, index, file),
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
          id: FormatDecode.makeId(provider.format, files),
          title: files.map((f) => f.fileName).join(', '),
          files,
          format: provider.format,
          decoded: { sections, notes },
          unreadableFiles,
        }
      })
    )

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing.
 *
 * @remarks
 * `R` is spelled at every use. A decode a `FileImporter` exposes is bound —
 * `Type<TSettings, TFormat, never>`; one still to be bound, as
 * {@link fromProvider} returns, is
 * `Type<TSettings, TFormat, SourceFile.FormatContext>`.
 */
type Type<TSettings, TFormat extends string> = WithContext<TSettings, TFormat, never>

type WithContext<TSettings, TFormat extends string, R> = (
  files: readonly PickedFile.PickedFile[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never, R>

export { fromProvider }
export type { Type, WithContext }
