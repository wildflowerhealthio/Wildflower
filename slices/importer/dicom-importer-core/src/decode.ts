/**
 * What makes a set of picked `.dcm` files one import, and how that set decodes
 * into one section of FHIR resources plus the notes that say what each file
 * contributed.
 *
 * @packageDocumentation
 */
import { DicomHeader } from '@wildflowerhealthio/dicom'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { DocumentReferenceContext } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodedFileSet,
  DecodedFile,
  type DecodeFunction,
  type FormatDecode,
  type PickedFile,
} from '@wildflowerhealthio/importer-fundamentals'
import { checkTimeZone } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'

import { dicomCalendarDate } from './fhir/dates.ts'
import { unresolvedUniversalIssuerOf } from './fhir/issuer.ts'
import {
  accessionNumbers,
  orderedInstances,
  patientKeyOf,
  toFhirResources,
} from './fhir/to-fhir.ts'
import type { StudyInstance } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'

/** One record a study synthesizes. */
type StudyResource = Effect.Effect.Success<ReturnType<typeof toFhirResources>>[number]

/**
 * Each study record's `fullUrl`, fixed and unique within one study: a study
 * synthesizes at most one record of each type.
 */
const STUDY_FULL_URLS = {
  Patient: 'patient',
  ServiceRequest: 'service-request',
  ImagingStudy: 'imaging-study',
} as const satisfies Record<StudyResource['resourceType'], string>

/** A study record as its section entry, under its type's fixed `fullUrl`. */
const studyEntryOf = (resource: StudyResource): DecodedFileSet.Entry => ({
  fullUrl: STUDY_FULL_URLS[resource.resourceType],
  resource,
})

/** One file of a study, as the synthesis sees it: its header and its name. */
interface StudyFile extends StudyInstance {
  readonly fileName: string
}

/** The `Identifier.system` FHIR spells a URI-valued identifier in, an OID as `urn:oid:<oid>`. */
const URI_IDENTIFIER_SYSTEM = 'urn:ietf:rfc:3986'

const decodeIdentifier = Schema.decodeSync(IdentifierAndReference.IdentifierSchema)

/**
 * A DICOM instance's SOP Instance UID as a FHIR `Identifier`, in FHIR's OID
 * convention: what a `.dcm` file identifies itself as, and what an
 * `ImagingStudy` instance's `uid` names.
 */
const sopInstanceIdentifier = (sopInstanceUid: string): IdentifierAndReference.IdentifierType =>
  decodeIdentifier({ system: URI_IDENTIFIER_SYSTEM, value: `urn:oid:${sopInstanceUid}` })

const asParseError = (reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, reason),
  })

/** This file's parsed header, or the rejection `dicom-parser` gave for it. */
const headerOf = (
  file: PickedFile.NamedBytes
): Either.Either<DicomHeader.Type, ParseResult.ParseError> =>
  Either.mapLeft(DicomHeader.tryFromDicomFile(file.bytes), (error) => asParseError(error.reason))

/**
 * What two files must agree on to be the same import: the study, and the
 * patient it is filed under.
 *
 * @remarks
 * `StudyInstanceUID` alone would be enough for well-formed data, and is not
 * what this keys on. A `PatientID` the files disagree on means one of them is
 * mislabelled or anonymized differently, and merging them would file one
 * patient's images in another's record — so a differing patient splits the set
 * instead, and the reviewer sees two sets with the same UID rather than one
 * silently merged. Both sets key one `ImagingStudy`, its Study Instance UID
 * (accepted), and {@link withSharedStudyNotes} says so on each. The patient is
 * the key the synthesis gives the `Patient` (Patient ID under its issuer, else
 * name and birth date), not the raw tag, so two spellings that key one
 * `Patient` stay one set.
 */
const studyKey = (header: DicomHeader.Type): string =>
  JSON.stringify([
    header.studyInstanceUid,
    Option.getOrNull(Option.map(patientKeyOf(header), ({ system, value }) => [system, value])),
  ])

/**
 * Which study a picked `.dcm` belongs to — the `groupBy` the DICOM importer
 * states.
 *
 * @param file - One picked `.dcm`
 * @returns The study's key, or the reason the file states none
 *
 * @remarks
 * Headers only, which is cheap enough to run over every picked file before any
 * synthesis. A file `dicom-parser` rejects is a `Left`: it states no
 * `StudyInstanceUID`, so there is no study to put it in, and folding it into a
 * neighbour's set would hide which file failed. The decode constructor turns
 * each `Left` into its own `unreadableFiles` row.
 */
const studyGroupKey = (file: PickedFile.Type): Either.Either<string, ParseResult.ParseError> =>
  Either.map(headerOf(file), studyKey)

/**
 * Build the section title from the study's representative header:
 * `<Modality> <StudyDescription> · <StudyDate>`, the date read as
 * `dicomCalendarDate` reads it and left out when it names no real day.
 * Modality is required of every header, so a study always names at least
 * that.
 */
const sectionTitle = (header: DicomHeader.Type): string => {
  const parts: string[] = [header.modality]
  if (header.studyDescription !== undefined) parts.push(header.studyDescription)
  const prefix = parts.join(' ')
  return Option.match(dicomCalendarDate(header.studyDate), {
    onNone: () => prefix,
    onSome: (studyDate) => `${prefix} · ${studyDate}`,
  })
}

/** How one file reads in the notes: which series and instance of the study it is. */
const contributionNote = ({ fileName, header }: StudyFile): string =>
  `${fileName}: series ${header.seriesNumber ?? header.seriesInstanceUid}, instance ${header.instanceNumber ?? header.sopInstanceUid}.`

/**
 * The notes for a stated issuer that names no URI — its number is then keyed
 * as one whose issuer the file does not state, beside every other such number:
 * the Patient ID's, read off the study's representative header, and the
 * Accession Number's, off the first file in study order stating one, as the
 * synthesis reads them.
 */
const unresolvedIssuerNotes = (files: readonly StudyFile[]): readonly string[] => {
  const ordered = orderedInstances(files)
  const patientIssuer = Option.flatMap(Arr.head(ordered), ({ header }) =>
    header.patientId === undefined
      ? Option.none()
      : unresolvedUniversalIssuerOf(header.issuerOfPatientIdQualifiers)
  )
  const accessionIssuer = Option.flatMap(
    Arr.findFirst(ordered, ({ header }) => header.accessionNumber !== undefined),
    ({ header }) => unresolvedUniversalIssuerOf(header.issuerOfAccessionNumber)
  )
  return Arr.getSomes([
    Option.map(
      patientIssuer,
      (issuer) =>
        `IssuerOfPatientIDQualifiersSequence names ${issuer}, which is no URI — the PatientID is keyed as one whose issuer is not stated.`
    ),
    Option.map(
      accessionIssuer,
      (issuer) =>
        `IssuerOfAccessionNumberSequence names ${issuer}, which is no URI — the AccessionNumber is keyed as one whose issuer is not stated.`
    ),
  ])
}

/** The notes a study's headers earn, beyond the resources they synthesize. */
const studyNotes = (files: readonly StudyFile[]): readonly string[] => {
  const notes: string[] = [...unresolvedIssuerNotes(files)]
  const accessions = accessionNumbers(files)
  if (accessions.length === 0) {
    notes.push('No AccessionNumber — no ServiceRequest will be created.')
  } else if (accessions.length > 1) {
    notes.push(
      `Files disagree on AccessionNumber (${accessions.join(', ')}) — the ServiceRequest uses ${accessions[0]}.`
    )
  }
  // A one-file study's contribution is its whole section; only a study spread
  // across files needs each file's place in it spelled out.
  if (files.length > 1) {
    for (const instance of orderedInstances(files)) notes.push(contributionNote(instance))
  }
  return notes
}

/** The reference to a decoded resource of the given type, when the decode produced one. */
const referenceTo = (
  decoded: DecodedFile.DecodedFile,
  resourceType: 'Patient' | 'ImagingStudy'
): Option.Option<string> =>
  Arr.findFirst(
    DecodedFile.resources(decoded),
    (entry) => entry.resource.resourceType === resourceType
  ).pipe(Option.map((entry) => `${resourceType}/${entry.resource.id}`))

/** A `Reference` naming one resource, built through the resource schema's own value. */
const referenceValue = (reference: string): typeof IdentifierAndReference.ReferenceSchema.Type => ({
  ...IdentifierAndReference.emptyReference,
  reference,
})

const emptyContext = Schema.decodeSync(DocumentReferenceContext.Schema)({})

/**
 * Link a study's source file to the study's own import: file it under the
 * `Patient` the decode synthesized, and relate it to the `ImagingStudy` it was
 * read into.
 *
 * @param sourceFile - The source file as `PickedFile.FromDocumentReference` minted it
 * @param decoded - The whole study's records, adopted
 * @returns The source file to store and list, with the same id it was minted under
 *
 * @remarks
 * `subject` is the epic's deliberate departure from the HAR/PDF source file
 * convention — a DICOM file is a clinical document and belongs in
 * `Patient/$everything`. `context.related` is what separates two studies of one
 * patient, whose `subject` is the same `Patient`.
 *
 * Read off the decode's *own* resources rather than re-derived from the
 * headers, so a source file names exactly the resources this decode is about to
 * write — the two cannot drift. Nothing here touches the source file's `id`: the
 * row listed for review and the reference every resource's `meta.source` names
 * are both read back off this result.
 */
const linkToPatientAndStudy = (
  sourceFile: PickedFile.SourceFile,
  decoded: DecodedFile.DecodedFile
): PickedFile.SourceFile => {
  const subject = referenceTo(decoded, 'Patient')
  const study = referenceTo(decoded, 'ImagingStudy')
  return {
    ...sourceFile,
    subject: Option.match(subject, {
      onNone: () => sourceFile.subject,
      onSome: (reference) => referenceValue(reference),
    }),
    context: Option.match(study, {
      onNone: () => sourceFile.context,
      onSome: (reference) => ({
        ...(sourceFile.context ?? emptyContext),
        related: [referenceValue(reference)],
      }),
    }),
  }
}

/**
 * Decode one study's picked files into a section of labeled FHIR resources,
 * each written detached, keyed by the identifiers its files carry.
 *
 * @param pickedFiles - Every picked `.dcm` of one study, in the order they were
 *   picked
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against
 * @returns One section when the study carries a patient, plus notes for what
 *   could not be extracted and what each file contributed, and each picked
 *   file identified as its SOP Instance UID ({@link sopInstanceIdentifier});
 *   fails with a
 *   `ParseError` when a header does not parse, when the time zone is not one
 *   the runtime resolves, or when a synthesized resource does not satisfy its
 *   schema
 *
 * @remarks
 * Each picked file's header is parsed here, having already been parsed once in
 * `groupBy` for the study key. A header that parsed there parses again; a
 * `Left` here is a `ParseError` for the whole set, which the decode constructor
 * folds into one `unreadableFiles` row per picked file.
 *
 * The resource keys are fixed — `patient`, `service-request`,
 * `imaging-study` — and are unique only *within* one study; the decode
 * function namespaces them by the set's first picked file.
 *
 * The time zone is rejected rather than substituted — a guess would write
 * `started` instants hours from what the equipment recorded — and it is one
 * setting for the whole batch, so an unresolvable zone fails every set.
 */
const decodeStudy = (
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  settings: DicomSettings
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  Effect.gen(function* () {
    yield* checkTimeZone(settings.timeZone)

    const pickedFilesWithHeaders = yield* Effect.forEach(pickedFiles, (pickedFile) =>
      Effect.map(headerOf(pickedFile), (header) => ({ pickedFile, header }))
    )
    const files: readonly StudyFile[] = pickedFilesWithHeaders.map(({ pickedFile, header }) => ({
      fileName: pickedFile.fileName,
      header,
    }))
    const identifiedPickedFiles = Arr.map(pickedFilesWithHeaders, ({ pickedFile, header }) => ({
      pickedFile,
      identifiedAs: Option.some(sopInstanceIdentifier(header.sopInstanceUid)),
    }))
    const ordered = orderedInstances(files)
    const head = ordered[0]
    if (head === undefined) return { sections: [], notes: [], pickedFiles: identifiedPickedFiles }

    if (Option.isNone(patientKeyOf(head.header))) {
      return {
        sections: [],
        notes: ['No patient identity in the DICOM header (no PatientID or PatientName).'],
        pickedFiles: identifiedPickedFiles,
      }
    }

    const notes = studyNotes(files)
    const resources = yield* toFhirResources(files, settings)
    const sections =
      resources.length > 0
        ? [{ title: sectionTitle(head.header), entries: resources.map(studyEntryOf) }]
        : []

    return { sections, notes, pickedFiles: identifiedPickedFiles }
  })

/**
 * The note a set earns when another set of its batch states its Study
 * Instance UID: under a different patient key, which is a different person or
 * the same Patient ID under an issuer spelled differently.
 */
const SHARED_STUDY_NOTE =
  'Other files in this pick state the same StudyInstanceUID under a different PatientID or issuer — they are read apart, and both are filed as one ImagingStudy.'

/** The `ImagingStudy` keys a set's sections carry: one per study, so at most one. */
const imagingStudyKeysOf = (fileSet: DecodedFileSet.Type): readonly string[] =>
  Arr.filterMap(
    fileSet.sections.flatMap((section) => section.entries),
    ({ resource }) =>
      resource.resourceType === 'ImagingStudy'
        ? Option.map(DetachedResource.keyOf(resource), ({ system, value }) =>
            JSON.stringify([system, value])
          )
        : Option.none()
  )

/**
 * A batch's decode with {@link SHARED_STUDY_NOTE} on each set whose
 * `ImagingStudy` another set of the batch keys too.
 *
 * @remarks
 * Files stating one Study Instance UID under two patient keys — two people,
 * or one Patient ID whose issuer the files spell differently — decode as two
 * sets ({@link studyKey}), and both key one `ImagingStudy` by that UID: the import
 * files them as one study (accepted). Only the whole batch sees both sets, so
 * the note is added here rather than in {@link decodeStudy}.
 */
const withSharedStudyNotes = <TFormat extends string>(
  decoded: FormatDecode.Decoded<TFormat>
): FormatDecode.Decoded<TFormat> => {
  const studyKeysBySet = decoded.fileSets.map(imagingStudyKeysOf)
  const setCountByStudyKey = Arr.reduce(
    studyKeysBySet.flat(),
    new Map<string, number>(),
    (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1)
  )
  return {
    ...decoded,
    fileSets: Arr.zipWith(decoded.fileSets, studyKeysBySet, (fileSet, studyKeys) =>
      studyKeys.some((key) => (setCountByStudyKey.get(key) ?? 0) > 1)
        ? { ...fileSet, notes: [...fileSet.notes, SHARED_STUDY_NOTE] }
        : fileSet
    ),
  }
}

export {
  decodeStudy,
  linkToPatientAndStudy,
  sectionTitle,
  SHARED_STUDY_NOTE,
  sopInstanceIdentifier,
  studyGroupKey,
  studyKey,
  withSharedStudyNotes,
}
export type { StudyFile }
