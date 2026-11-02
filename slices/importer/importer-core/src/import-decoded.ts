import { adoptUnderKey } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFile,
  type DecodedFileSet,
  DecodedRecord,
  type FileImporter,
  FormatDecode,
  MetaSource,
  PickedFile,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Function, Option, Order, type ParseResult, Schema } from 'effect'

/**
 * The import stage: one format's decode, file set by file set, made the
 * device's own. The one place a record is adopted, a source file is minted
 * and `meta.source` is stamped.
 *
 * @remarks
 * Per set, {@link importFileSet} mints a source file for every member
 * (`PickedFile.FromDocumentReference`'s encode), adopts each `FromSource`
 * record (`adoptUnderKey`, its references keyed in its section's system
 * family) and keeps each `Adopted` one, runs the format's `linkSourceFile`
 * over every source file and its `finish` over every record, stamps every
 * record's `meta.source` with the set's representative source file, and
 * leads with the source files as the set's own section. Each set's records are
 * keyed as they are: nothing is de-duplicated across sets or files.
 *
 * @packageDocumentation
 */

/** What the import stage reads off a format's importer: its source-file constants and hooks. */
type ImportingFormat = Pick<
  FileImporter.Type<unknown, string, unknown>,
  'sourceFileFormat' | 'linkSourceFile' | 'finish'
>

/** The section title one picked file's source file is reviewed under. */
const SOURCE_FILE_SECTION_TITLE = 'Source file'

/** The section title several source files read together are reviewed under. */
const SOURCE_FILES_SECTION_TITLE = 'Source files'

/** The review key of a source file row, stable across a settings re-decode. */
const sourceFileKey = (file: PickedFile.Type): string =>
  `${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`

const mintSourceFile = Schema.encode(PickedFile.FromDocumentReference)

/**
 * One section's records, adopted: each `FromSource` record under its key, its
 * references keyed in the section's system family, each `Adopted` one as it
 * is.
 *
 * @remarks
 * A `FromSource` record in a section that names no system family is a decode
 * that broke `DecodedFileSet.Section`'s contract, and dies here.
 */
const adoptSection = (section: DecodedFileSet.Section): DecodedFile.Section => {
  const adopt = Option.map(section.systemFamily, adoptUnderKey)
  return {
    title: section.title,
    resources: section.entries.map(({ key, title, record }): DecodedFile.Resource => ({
      key,
      title,
      resource: DecodedRecord.$match(record, {
        Adopted: ({ resource }) => resource,
        FromSource: (fromSource) =>
          Option.getOrThrowWith(
            adopt,
            () => new Error(`${key}: a FromSource record in a section with no system family`)
          )(fromSource),
      }),
    })),
  }
}

/**
 * Import one file set: mint its members' source files, adopt its records, let
 * the format link each source file and finish each record, stamp, and lead
 * with the source files it is about to store.
 *
 * @remarks
 * `meta.source` names the set's representative: the member whose source file
 * id is lexicographically smallest. A source file's id is a content hash of the
 * file's bytes and name, so the smallest of them is a fact about the set and
 * not about the order it was picked in, which is what makes the same study,
 * picked any way round, import identical resources.
 */
const importFileSet = (
  importer: ImportingFormat,
  fileSet: DecodedFileSet.Type
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, PickedFile.Format> =>
  Effect.gen(function* () {
    const minted = yield* Effect.all(
      Arr.map(fileSet.members, (member) =>
        Effect.map(mintSourceFile(member), (sourceFile) => ({ member, sourceFile }))
      ),
      { concurrency: 'unbounded' }
    )
    const adopted: DecodedFile.DecodedFile = {
      sections: fileSet.sections.map(adoptSection),
      notes: fileSet.notes,
    }

    const linkSourceFile = importer.linkSourceFile ?? Function.identity
    const linked = Arr.map(minted, ({ member, sourceFile }) => ({
      member,
      sourceFile: linkSourceFile(sourceFile, adopted),
    }))

    const finish = importer.finish ?? Function.identity
    const sourceFileIds = new Map(
      linked.map(({ member, sourceFile }) => [member.id, sourceFile.id])
    )
    const stamped = MetaSource.stampDecoded(
      DecodedFile.mapResources(adopted, (entry) => ({
        ...entry,
        resource: finish(entry.resource, sourceFileIds),
      })),
      MetaSource.makeReference(
        Arr.min(
          Arr.map(linked, ({ sourceFile }) => sourceFile.id),
          Order.string
        )
      )
    )

    const rows = linked.map(({ member, sourceFile }): DecodedFile.Resource => ({
      key: sourceFileKey(member),
      title: member.fileName,
      resource: sourceFile,
    }))
    // Their own section ahead of what was read out of them, so the reviewer
    // sees what is about to be stored before what it yielded.
    const title = rows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
    return { ...stamped, sections: [{ title, resources: rows }, ...stamped.sections] }
  })

/**
 * Import one format's decode: every file set through {@link importFileSet},
 * merged into the one review the format's {@link FormatDecode.Result} holds.
 *
 * @param importer - The format's importer, whose source-file constants and
 *   hooks the import reads
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The imported result, never failing
 *
 * @remarks
 * Sets are imported concurrently and each is independent: one whose source
 * file cannot be minted yields an `unreadableFiles` row per member, after the
 * rows the decode already reported, while the rest stay reviewable. It
 * provides the `PickedFile.Format` service from the importer's
 * `sourceFileFormat` internally, so nothing it returns carries a requirement.
 */
const importDecoded = <TFormat extends string>(
  importer: ImportingFormat,
  decoded: FormatDecode.Decoded<TFormat>
): Effect.Effect<FormatDecode.Result<TFormat>> =>
  Effect.forEach(
    decoded.fileSets,
    (fileSet) =>
      importFileSet(importer, fileSet).pipe(
        Effect.mapError((error) =>
          fileSet.members.map((file) => FormatDecode.unreadableFile(decoded.format, file, error))
        ),
        Effect.either
      ),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((results): FormatDecode.Result<TFormat> => {
      const [rejected, imported] = Arr.partitionMap(results, Function.identity)
      return {
        id: FormatDecode.makeId(decoded.format, decoded.files),
        title: decoded.files.map((file) => file.fileName).join(', '),
        files: decoded.files,
        format: decoded.format,
        decoded: {
          sections: imported.flatMap((one) => one.sections),
          notes: imported.flatMap((one) => one.notes),
        },
        unreadableFiles: [...decoded.unreadableFiles, ...rejected.flat()],
      }
    }),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

export { importDecoded }
export type { ImportingFormat }
