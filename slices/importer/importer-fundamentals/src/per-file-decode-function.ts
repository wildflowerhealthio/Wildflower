/**
 * One kind of decode function: the batch decode of a format whose files decode
 * independently, built from that format's per-file step.
 *
 * @remarks
 * `decode-function.ts` is the general contract — files and settings in, one
 * `FormatDecode.Result` out. This module is *one constructor* of that contract,
 * and the assumption it adds is that the files are independent of each other.
 * That assumption is what earns everything {@link make} does: running the files
 * concurrently, namespacing each one's review keys by its slot, and folding a
 * rejecting file into its own `unreadableFiles` row while the rest stay
 * reviewable.
 *
 * A format whose files must be read *together* — a multi-part archive, a
 * manifest naming its siblings — needs a sibling constructor beside this one,
 * not a widened version of it. `dicom-importer-core`'s study decode is the
 * first; what the two genuinely share — resolving a pick to its source-file
 * reference, and listing the minted archives as their own section — is
 * `source-file-mint.ts`, not this module.
 *
 * @packageDocumentation
 */

import { Effect, Either, type ParseResult } from 'effect'
import type * as DecodeFunction from './decode-function.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type * as PickedFile from './picked-file.ts'
import type * as SourceFileCodec from './source-file-codec.ts'
import * as SourceFileMint from './source-file-mint.ts'
import type * as SourceFile from './source-file.ts'

/**
 * How a format names the subject its minted source file is filed under.
 *
 * @remarks
 * Called with the file's *decode*, not just its bytes, so a format reads the
 * subject off the resources it already extracted rather than parsing the file
 * twice. `undefined` leaves the source file with no `subject` — the default,
 * which keeps an engineering artifact out of `Patient/$everything`.
 *
 * Lives here rather than beside the codec because it is a *decode* seam: the
 * only thing that calls it is {@link make}, and the only reason it exists is
 * that the subject cannot be known until the file's decode has run.
 */
type FileSubjectForPair = (
  file: PickedFile.Type,
  decoded: DecodedFile.DecodedFile
) => SourceFileCodec.Subject | undefined

/**
 * What {@link make} needs of a format: its tag, its per-file decode, and — when
 * it files its source file under a subject — its `subjectFor`.
 *
 * @remarks
 * **Per-file** is the assumption, not a filler word. It constrains both ends:
 * `decodeOne` is handed one file and *cannot see the others*, and the per-file
 * results **sum** into the batch's — sections concatenate, notes concatenate,
 * unreadable files accumulate, and no file's decode can change another's.
 * Reaching for this constructor and trying to smuggle cross-file state through
 * `settings` is the failure mode the module's own remarks exist to make
 * obvious.
 *
 * The source-file operations are not parameters: this module goes through
 * `source-file-mint.ts`, which calls the codec unbound, so the decode it
 * builds still carries the `SourceFileCodec.FormatContext` requirement for
 * `FileImporter.make` to discharge in one place. That is the whole reason this
 * module takes no `SourceFileCodec.Format`: a second copy of a format's coding
 * constants here could disagree with the one the importer reads its
 * `categoryToken` and `isSourceFile` out of, and nothing would catch it.
 */
interface Config<TFormat extends string, TSettings> {
  readonly format: TFormat
  /** How this format names its source file's subject, when it names one at all. */
  readonly subjectFor?: FileSubjectForPair | undefined
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
 * Lift a format whose files decode one at a time — see {@link Config} — into
 * the batch `decode` the shell runs: each file decoded on its own and
 * concurrently, each contributing its own "Source file" row, its sections under
 * its own key namespace, and its own unreadable row when it rejects.
 *
 * @param config - The format's tag, per-file decode, and optional `subjectFor`
 * @returns The format's batch `decode`, which never fails, still needing its `SourceFileCodec.FormatContext`
 */
const make =
  <TFormat extends string, TSettings>(
    config: Config<TFormat, TSettings>
  ): DecodeFunction.WithContext<TSettings, TFormat, SourceFileCodec.FormatContext> =>
  (
    files: readonly PickedFile.Type[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>, never, SourceFileCodec.FormatContext> =>
    Effect.forEach(
      files,
      (file, index) => {
        const prefix = FormatDecode.keyPrefix(index, file)
        return Effect.gen(function* () {
          const resolved = yield* SourceFileMint.resolve(file)
          const decoded = yield* config.decodeOne(file, settings, resolved.reference)
          const stamped = MetaSource.stampDecoded(
            DecodedFile.namespaceKeys(decoded, prefix),
            resolved.reference
          )
          if (resolved.encode === undefined) return Either.right(stamped)
          const resource = yield* resolved.encode({ subject: config.subjectFor?.(file, decoded) })
          return Either.right(
            SourceFileMint.prependSection(stamped, [
              {
                key: `${prefix}${SourceFileMint.key(file.fileName)}`,
                title: file.fileName,
                resource,
              },
            ])
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

export { make }
export type { Config, FileSubjectForPair }
