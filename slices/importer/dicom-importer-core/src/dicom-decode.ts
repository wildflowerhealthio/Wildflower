/**
 * DICOM's batch decode: a pick of `.dcm` files in, one `ImagingStudy` per
 * study out.
 *
 * @remarks
 * The second constructor of `importer-fundamentals`' `DecodeFunction`
 * contract rather than a `PerFileDecodeFunction`, because a study's files are
 * not independent: each states one instance of a study whose counts, modality
 * set and earliest `started` only the whole set knows. The obligations a group
 * decode takes on in exchange are listed in the
 * [Adding a File-Format Importer How-To](../../docs/Adding%20a%20File-Format%20Importer%20How-To.md).
 *
 * @packageDocumentation
 */
import { Effect, Either, ParseResult, Schema } from 'effect'
import {
  DecodedFile,
  type DecodeFunction,
  FormatDecode,
  MetaSource,
  type PickedFile,
  SourceFile,
  type SourceFileCodec,
  SourceFileMint,
} from 'importer-fundamentals'
import { checkTimeZone } from 'kitchen-sink'

import { decodeStudy, type StudyFile } from './decode.ts'
import { orderedInstances } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'
import { partition, type ParsedFile, type StudyUnit } from './study-unit.ts'

/** The format tag this decode results carry. */
const DICOM_FORMAT = 'dicom'

const asParseError = (reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, reason),
  })

/** The `unreadableFiles` row one picked file is reported as when its unit rejects. */
const unreadableRow = (
  file: PickedFile.Type,
  index: number,
  error: ParseResult.ParseError
): FormatDecode.UnreadableFile => ({
  id: FormatDecode.makeFileId(DICOM_FORMAT, index, file),
  title: file.fileName,
  pickedFile: file,
  error,
})

/**
 * The reference to a decoded resource of the given type, or `undefined` when
 * the decode produced none.
 *
 * @remarks
 * Reads the decode's *own* resources rather than re-deriving ids from the
 * headers, so the archive's `subject` and `context.related` name exactly the
 * resources this decode is about to write — the two cannot drift.
 */
const referenceTo = (
  decoded: DecodedFile.DecodedFile,
  resourceType: 'Patient' | 'ImagingStudy'
): { readonly reference: string } | undefined => {
  const id = DecodedFile.resources(decoded).find(
    (entry) => entry.resource.resourceType === resourceType
  )?.resource.id
  if (id === undefined || id === null) return undefined
  return { reference: `${resourceType}/${id}` }
}

/**
 * How a study's archives are filed: in the patient's record, and as sources of
 * the study read out of them.
 *
 * @remarks
 * `subject` is the epic's deliberate departure from the HAR/PDF archive
 * convention — a DICOM file is a clinical document and belongs in
 * `Patient/$everything`. `context.related` is what separates two studies of
 * one patient, whose `subject` is the same `Patient`.
 */
const archiveFiling = (decoded: DecodedFile.DecodedFile): SourceFileCodec.Filing => {
  const study = referenceTo(decoded, 'ImagingStudy')
  return {
    subject: referenceTo(decoded, 'Patient'),
    related: study === undefined ? undefined : [study],
  }
}

/**
 * Decode one study: mint its files' archives, synthesize its resources, and
 * return them as one reviewable unit.
 *
 * @remarks
 * `meta.source` holds one reference and a study has as many archives as
 * files, so one archive stands for the study: its representative instance's,
 * chosen by the study's own order rather than the pick's so the stamp is the
 * same however the files were picked. Per-file provenance is not lost to that
 * choice — each `ImagingStudy.instance` names its own archive through its
 * `gridfsFileId` extension.
 */
const decodeUnit = (
  unit: StudyUnit,
  settings: DicomSettings
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, SourceFileCodec.FormatContext> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(unit.files, (member) =>
      SourceFileMint.resolve(member.file)
    )
    const files: readonly StudyFile[] = unit.files.map((member, slot) => ({
      file: member.file,
      header: member.header,
      sourceFileId: SourceFile.idFromReference(resolved[slot].reference),
    }))

    const decoded = yield* decodeStudy(files, settings)
    const opening = unit.files[0]
    const namespaced = DecodedFile.namespaceKeys(
      decoded,
      FormatDecode.keyPrefix(opening.index, opening.file)
    )

    const representative = orderedInstances(files)[0]
    const stamped =
      representative === undefined || representative.sourceFileId === undefined
        ? namespaced
        : MetaSource.stampDecoded(namespaced, SourceFile.makeReference(representative.sourceFileId))

    const filing = archiveFiling(decoded)
    const rows: DecodedFile.Resource[] = []
    for (const [slot, member] of unit.files.entries()) {
      const encode = resolved[slot].encode
      if (encode === undefined) continue
      rows.push({
        key: `${FormatDecode.keyPrefix(member.index, member.file)}${SourceFileMint.key(member.file.fileName)}`,
        title: member.file.fileName,
        resource: yield* encode(filing),
      })
    }

    return SourceFileMint.prependSection(stamped, rows)
  })

/** Every file of a unit, as the `unreadableFiles` rows its rejection produces. */
const unitRejection = (
  files: readonly ParsedFile[],
  error: ParseResult.ParseError
): readonly FormatDecode.UnreadableFile[] =>
  files.map((member) => unreadableRow(member.file, member.index, error))

/**
 * DICOM's batch decode: partition the pick into studies, decode each, and fold
 * them into one result.
 *
 * @param files - Every `.dcm` the format claimed, in pick order
 * @param settings - The import's settings
 * @returns The batch's sections, notes and unreadable rows — one study per
 *   section, one row per file that could not be read
 *
 * @remarks
 * `settings.timeZone` is rejected up front rather than substituted: every
 * `ImagingStudy.started` in the batch is resolved against it, so a guess would
 * write instants hours away from what the equipment recorded. It is one
 * setting for the whole pick, so an unresolvable zone fails every file at
 * once.
 */
const decodeDicomBatch: DecodeFunction.WithContext<
  DicomSettings,
  typeof DICOM_FORMAT,
  SourceFileCodec.FormatContext
> = (files, settings) =>
  Effect.gen(function* () {
    const result = (
      decoded: DecodedFile.DecodedFile,
      unreadableFiles: readonly FormatDecode.UnreadableFile[]
    ): FormatDecode.Result<typeof DICOM_FORMAT> => ({
      id: FormatDecode.makeId(DICOM_FORMAT, files),
      title: files.map((file) => file.fileName).join(', '),
      files,
      format: DICOM_FORMAT,
      decoded,
      unreadableFiles,
    })

    const zone = yield* Effect.either(checkTimeZone(settings.timeZone))
    if (Either.isLeft(zone)) {
      return result(
        { sections: [], notes: [] },
        files.map((file, index) => unreadableRow(file, index, zone.left))
      )
    }

    const { units, unparsed } = partition(files)
    const decodedUnits = yield* Effect.forEach(
      units,
      (
        unit
      ): Effect.Effect<
        Either.Either<DecodedFile.DecodedFile, readonly FormatDecode.UnreadableFile[]>,
        never,
        SourceFileCodec.FormatContext
      > =>
        decodeUnit(unit, settings).pipe(
          Effect.map(Either.right),
          Effect.catchAll((error) => Effect.succeed(Either.left(unitRejection(unit.files, error))))
        ),
      { concurrency: 'unbounded' }
    )

    const sections: DecodedFile.Section[] = []
    const notes: string[] = []
    const unreadableFiles: FormatDecode.UnreadableFile[] = unparsed.map((member) =>
      unreadableRow(member.file, member.index, asParseError(member.reason))
    )
    for (const decoded of decodedUnits) {
      Either.match(decoded, {
        onLeft: (rejected) => unreadableFiles.push(...rejected),
        onRight: (unit) => {
          sections.push(...unit.sections)
          notes.push(...unit.notes)
        },
      })
    }

    return result({ sections, notes }, unreadableFiles)
  })

export { decodeDicomBatch }
