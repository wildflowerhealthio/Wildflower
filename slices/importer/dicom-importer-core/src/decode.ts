/**
 * What makes a set of picked `.dcm` files one import, and how that set decodes
 * into one section of FHIR resources plus the notes that say what each file
 * contributed.
 *
 * @packageDocumentation
 */
import { DicomHeader } from 'dicom'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import { adoptResource } from 'fhir-r4/identity'
import {
  type DocumentReference,
  DocumentReferenceContext,
  type FhirResource,
} from 'fhir-r4/resources'
import { type DecodeFunction, DecodedFile, type PickedFile } from 'importer-fundamentals'
import { checkTimeZone } from 'kitchen-sink'

import {
  accessionNumbers,
  orderedInstances,
  patientOriginalId,
  toFhirResources,
} from './fhir/to-fhir.ts'
import type { StudyInstance } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: DICOM_SYSTEM })

const labelAdopted = (resource: FhirResource, key: string, title: string): DecodedFile.Resource => {
  const adopted = adopt(resource)
  return { key, title, resource: adopted }
}

/** One file of a study, as the synthesis sees it: its header, its archive, its pick. */
interface StudyFile extends StudyInstance {
  readonly fileName: string
}

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
 * instead, and the reviewer sees two studies with the same UID rather than one
 * silently merged. Patient identity is the id the synthesis derives
 * (`PatientID` + issuer, else name + birth date), not the raw tag, so two
 * spellings that mint the same `Patient` stay one set.
 */
const studyKey = (header: DicomHeader.Type): string =>
  `${header.studyInstanceUid}\u0000${patientOriginalId(header) ?? ''}`

/**
 * Which study a picked `.dcm` belongs to — the `groupBy` the DICOM importer
 * states.
 *
 * @param file - One picked `.dcm`
 * @returns The study's key, or the reason the file states none
 *
 * @remarks
 * Headers only, which is cheap enough to run over a whole pick before any
 * synthesis. A file `dicom-parser` rejects is a `Left`: it states no
 * `StudyInstanceUID`, so there is no study to put it in, and folding it into a
 * neighbour's set would hide which file failed. The decode constructor turns
 * each `Left` into its own `unreadableFiles` row.
 */
const studyGroupKey = (file: PickedFile.Type): Either.Either<string, ParseResult.ParseError> =>
  Either.map(headerOf(file), studyKey)

/**
 * Build the section title from the study's representative header:
 * `<Modality> <StudyDescription> · <StudyDate>`. Modality is required of every
 * header, so a study always names at least that.
 */
const sectionTitle = (header: DicomHeader.Type): string => {
  const parts: string[] = [header.modality]
  if (header.studyDescription !== undefined) parts.push(header.studyDescription)
  const prefix = parts.join(' ')
  if (header.studyDate !== undefined) {
    const y = header.studyDate.slice(0, 4)
    const m = header.studyDate.slice(4, 6)
    const d = header.studyDate.slice(6, 8)
    return `${prefix} · ${y}-${m}-${d}`
  }
  return prefix
}

/** How one file reads in the notes: which series and instance of the study it is. */
const contributionNote = ({ fileName, header }: StudyFile): string =>
  `${fileName}: series ${header.seriesNumber ?? header.seriesInstanceUid}, instance ${header.instanceNumber ?? header.sopInstanceUid}.`

/** The notes a study's headers earn, beyond the resources they synthesize. */
const studyNotes = (files: readonly StudyFile[]): readonly string[] => {
  const notes: string[] = []
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
  ).pipe(
    Option.flatMap((entry) => Option.fromNullable(entry.resource.id)),
    Option.map((id) => `${resourceType}/${id}`)
  )

/** A `Reference` naming one resource, built through the resource schema's own value. */
const referenceValue = (reference: string): typeof IdentifierAndReference.ReferenceSchema.Type => ({
  ...IdentifierAndReference.emptyReference,
  reference,
})

const emptyContext = Schema.decodeSync(DocumentReferenceContext.Schema)({})

/**
 * Finish a study's archive off the study's own decode: file it under the
 * `Patient` the decode synthesized, and relate it to the `ImagingStudy` it was
 * read into.
 *
 * @param minted - The archive as `PickedFile.FromDocumentReference` minted it
 * @param decoded - The whole study's decode
 * @returns The archive to store and list, with the same id it was minted under
 *
 * @remarks
 * `subject` is the epic's deliberate departure from the HAR/PDF archive
 * convention — a DICOM file is a clinical document and belongs in
 * `Patient/$everything`. `context.related` is what separates two studies of one
 * patient, whose `subject` is the same `Patient`.
 *
 * Read off the decode's *own* resources rather than re-derived from the
 * headers, so an archive names exactly the resources this decode is about to
 * write — the two cannot drift. Nothing here touches the archive's `id`: the
 * row listed for review and the reference every resource's `meta.source` names
 * are both read back off this result.
 */
const archive = (
  minted: DocumentReference.Type,
  decoded: DecodedFile.DecodedFile
): DocumentReference.Type => {
  const subject = referenceTo(decoded, 'Patient')
  const study = referenceTo(decoded, 'ImagingStudy')
  return {
    ...minted,
    subject: Option.match(subject, {
      onNone: () => minted.subject,
      onSome: (reference) => referenceValue(reference),
    }),
    context: Option.match(study, {
      onNone: () => minted.context,
      onSome: (reference) => ({
        ...(minted.context ?? emptyContext),
        related: [referenceValue(reference)],
      }),
    }),
  }
}

/**
 * Decode one study's picked files into a section of adopted, labeled FHIR
 * resources.
 *
 * @param members - Every picked `.dcm` of one study, in pick order, each with
 *   the archive storing it (whose id is the instance's `gridfsFileId`)
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against
 * @returns One section when the study carries a patient, plus notes for what
 *   could not be extracted and what each file contributed; fails with a
 *   `ParseError` when a header does not parse, when the time zone is not one
 *   the runtime resolves, or when a synthesized resource does not satisfy its
 *   schema
 *
 * @remarks
 * Each member's header is parsed here, having already been parsed once in
 * `groupBy` for the study key. A header that parsed there parses again; a
 * `Left` here is a `ParseError` for the whole set, which the decode constructor
 * folds into one `unreadableFiles` row per member.
 *
 * The resource keys are fixed — `patient`, `service-request`,
 * `imaging-study` — and are unique only *within* one study; the decode
 * function namespaces them by the set's first pick.
 *
 * The time zone is rejected rather than substituted — a guess would write
 * `started` instants hours from what the equipment recorded — and it is one
 * setting for the whole pick, so an unresolvable zone fails every set.
 */
const decodeStudy = (
  members: Arr.NonEmptyReadonlyArray<DecodeFunction.ArchivedFile>,
  settings: DicomSettings
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  Effect.gen(function* () {
    yield* checkTimeZone(settings.timeZone)

    const files: readonly StudyFile[] = yield* Effect.forEach(members, (member) =>
      Effect.map(headerOf(member), (header) => ({
        fileName: member.fileName,
        header,
        sourceFileId: member.archive.id ?? undefined,
      }))
    )
    const ordered = orderedInstances(files)
    const head = ordered[0]
    if (head === undefined) return { sections: [], notes: [] }

    if (patientOriginalId(head.header) === undefined) {
      return {
        sections: [],
        notes: ['No patient identity in the DICOM header (no PatientID or PatientName).'],
      }
    }

    const notes = studyNotes(files)
    const resources = yield* toFhirResources(files, settings)
    const labeled: DecodedFile.Resource[] = []

    for (const resource of resources) {
      switch (resource.resourceType) {
        case 'Patient':
          labeled.push(labelAdopted(resource, 'patient', `Patient/${resource.id}`))
          break
        case 'ServiceRequest':
          labeled.push(labelAdopted(resource, 'service-request', `ServiceRequest/${resource.id}`))
          break
        case 'ImagingStudy':
          labeled.push(labelAdopted(resource, 'imaging-study', `ImagingStudy/${resource.id}`))
          break
        default:
          break
      }
    }

    const sections: DecodedFile.Section[] =
      labeled.length > 0 ? [{ title: sectionTitle(head.header), resources: labeled }] : []

    return { sections, notes }
  })

export { archive, decodeStudy, sectionTitle, studyGroupKey, studyKey }
export type { StudyFile }
