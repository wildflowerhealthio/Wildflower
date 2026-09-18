import { Effect, Either, type ParseResult } from 'effect'
import { type DocumentReference } from 'fhir-r4/resources'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * What {@link fromPerFile} needs of a format: its tag, its per-file decode, and
 * — when it files its source file under a subject — its `subjectFor`.
 *
 * @remarks
 * **Per-file** is the assumption, not a filler word. It constrains both ends:
 * `decodeOne` is handed one file and *cannot see the others*, and the per-file
 * results **sum** into the batch's — sections concatenate, notes concatenate,
 * unreadable files accumulate, and no file's decode can change another's. That
 * is what lets {@link fromPerFile} run the files concurrently and fold one bad
 * file into its own `unreadableFiles` row while the rest stay reviewable.
 *
 * It is one way to build a {@link Type}, not the only one. A format whose files
 * must be read *together* — a multi-part archive, a manifest naming its
 * siblings, anything where the batch is more than the sum of its files — is not
 * per-file, and needs its own constructor here rather than a widened version of
 * this one. Reaching for this one and trying to smuggle cross-file state
 * through `settings` is the failure mode it exists to make obvious.
 *
 * The source-file operations are not parameters: this module calls
 * `SourceFile.tryFromNamedBytes` and `SourceFile.encode` directly,
 * unbound, so the decode it builds still carries the
 * `SourceFile.FormatContext` requirement for `FileImporter.make` to discharge
 * in one place. That is the whole reason this module takes no
 * `SourceFile.Format`: a second copy of a format's coding constants here could
 * disagree with the one the importer reads its `categoryToken` and
 * `isSourceFile` out of, and nothing would catch it.
 */
interface PerFileConfig<TFormat extends string, TSettings> extends SourceFile.PerFileDecodeOptions {
  readonly format: TFormat
  /**
   * One format's per-file decode step, given the file, its settings, and the
   * reference to the source file every resource it yields will be stamped with —
   * minted for a `local` pick, the existing one for a `server` pick.
   */
  readonly decodeOne: (
    file: PickedFile.Type,
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
  file: PickedFile.Type
): Effect.Effect<ResolvedSource, ParseResult.ParseError, SourceFile.FormatContext> => {
  if (file.source._tag === 'server') {
    return Effect.succeed({ reference: file.source.reference, mintResource: undefined })
  }
  return SourceFile.tryFromNamedBytes(file).pipe(
    Effect.map((sourceFile) => ({
      reference: SourceFile.makeReference(sourceFile.id),
      mintResource: (subject: SourceFile.Subject | undefined) =>
        SourceFile.encode(sourceFile, subject),
    }))
  )
}

/**
 * Lift a format whose files decode one at a time — see {@link PerFileConfig} —
 * into the batch `decode` the shell runs: each file decoded on its own and
 * concurrently, each contributing its own "Source file" row, its sections under
 * its own key namespace, and its own unreadable row when it rejects.
 *
 * @param config - The format's tag, per-file decode, and optional `subjectFor`
 * @returns The format's batch `decode`, which never fails, still needing its `SourceFile.FormatContext`
 */
const fromPerFile =
  <TFormat extends string, TSettings>(
    config: PerFileConfig<TFormat, TSettings>
  ): WithContext<TSettings, TFormat, SourceFile.FormatContext> =>
  (
    files: readonly PickedFile.Type[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>, never, SourceFile.FormatContext> =>
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
      })
    )

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing and requiring nothing.
 *
 * @remarks
 * This is the bound end of {@link WithContext} — what a `FileImporter` exposes,
 * once `FileImporter.make` has discharged the source-file context.
 * {@link fromPerFile} returns the unbound end, and is one constructor of this
 * type rather than the only one.
 */
type Type<in TSettings, TFormat extends string> = WithContext<TSettings, TFormat, never>

/**
 * A batch decode with its requirement still spelled: `never` once
 * `FileImporter.make` has bound it, `SourceFile.FormatContext` while the
 * format's coding constants are still to be provided.
 */
type WithContext<in TSettings, TFormat extends string, R> = (
  files: readonly PickedFile.Type[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never, R>

export { fromPerFile }
export type { PerFileConfig, Type, WithContext }
