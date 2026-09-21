/**
 * What makes a set of picked `.dcm` files one import, and how that set decodes
 * into one section of FHIR resources plus the notes that say what each file
 * contributed.
 *
 * @packageDocumentation
 */
import { DicomHeader } from 'dicom'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { type DecodeFunction, DecodedFile, SourceFile } from 'importer-fundamentals'
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

/** A picked `.dcm` whose header parsed, with the slot it was picked in. */
interface ParsedFile extends DecodeFunction.Member {
  readonly header: DicomHeader.Type
}

/** One study's picked files, in study order. Never empty. */
type StudyFileSet = Arr.NonEmptyReadonlyArray<ParsedFile>

/** One file of a study once its archive is known — what {@link decodeStudy} reads. */
type StudyMember = ParsedFile & { readonly sourceFile: SourceFile.Reference }

/** One file of a study, as the synthesis sees it: its header, its archive, its pick. */
interface StudyFile extends StudyInstance {
  readonly file: DecodeFunction.Member['file']
}

const asParseError = (reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, reason),
  })

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

/** A study's files in study order, so the first of them is its representative. */
const inStudyOrder = (members: StudyFileSet): StudyFileSet => {
  const ordered = orderedInstances(members)
  return Arr.isNonEmptyReadonlyArray(ordered) ? ordered : members
}

/**
 * Split a picked batch into its studies.
 *
 * @param files - Every `.dcm` the format claimed, in pick order
 * @returns One file set per study, each in study order, and the picks whose
 *   headers did not parse
 *
 * @remarks
 * Parses headers and nothing else — cheap enough to run over a whole pick
 * before any synthesis. A file that fails to parse is its own row rather than
 * a member of some study: it states no `StudyInstanceUID`, so there is no
 * study to put it in, and folding it into a neighbour's set would hide which
 * file failed.
 *
 * Each set is ordered by the study's own order rather than the pick's, so the
 * representative the decode function namespaces keys by and stamps
 * `meta.source` with is the same however the files were picked.
 */
const partitionStudies = (
  files: readonly DecodeFunction.Member[]
): DecodeFunction.Partition<ParsedFile> => {
  const [unreadable, parsed] = Arr.partitionMap(
    files,
    (member): Either.Either<ParsedFile, DecodeFunction.UnreadableMember> => {
      const header = DicomHeader.tryFromDicomFile(member.file.bytes)
      return Either.isLeft(header)
        ? Either.left({ member, error: asParseError(header.left.reason) })
        : Either.right({ ...member, header: header.right })
    }
  )
  // `groupBy` keys are insertion-ordered, so the sets come out ordered by the
  // pick that opened each — the order the reviewer picked the files in.
  return {
    fileSets: Object.values(Arr.groupBy(parsed, (member) => studyKey(member.header))).map(
      inStudyOrder
    ),
    unreadable,
  }
}

/**
 * Build the section title from the study's representative header:
 * `<Modality> <StudyDescription> · <StudyDate>`, falling back to
 * `DICOM study` when nothing is available.
 */
const sectionTitle = (header: DicomHeader.Type): string => {
  const parts: string[] = []
  if (header.modality !== undefined) parts.push(header.modality)
  if (header.studyDescription !== undefined) parts.push(header.studyDescription)
  const prefix = parts.length === 0 ? 'DICOM study' : parts.join(' ')
  if (header.studyDate !== undefined) {
    const y = header.studyDate.slice(0, 4)
    const m = header.studyDate.slice(4, 6)
    const d = header.studyDate.slice(6, 8)
    return `${prefix} · ${y}-${m}-${d}`
  }
  return prefix
}

/** How one file reads in the notes: which series and instance of the study it is. */
const contributionNote = ({ file, header }: StudyFile): string =>
  `${file.fileName}: series ${header.seriesNumber ?? header.seriesInstanceUid}, instance ${header.instanceNumber ?? header.sopInstanceUid}.`

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

/**
 * The links a study's archives carry: the patient whose record they belong in,
 * and the study they were read into.
 *
 * @remarks
 * `subject` is the epic's deliberate departure from the HAR/PDF archive
 * convention — a DICOM file is a clinical document and belongs in
 * `Patient/$everything`. `related` is what separates two studies of one
 * patient, whose `subject` is the same `Patient`.
 *
 * Read off the decode's *own* resources rather than re-derived from the
 * headers, so an archive names exactly the resources this decode is about to
 * write — the two cannot drift.
 */
const archiveLinks = (decoded: DecodedFile.DecodedFile): DecodeFunction.ArchiveLinks => ({
  subject: referenceTo(decoded, 'Patient'),
  related: Arr.getSomes([referenceTo(decoded, 'ImagingStudy')]),
})

/** The reference to a decoded resource of the given type, when the decode produced one. */
const referenceTo = (
  decoded: DecodedFile.DecodedFile,
  resourceType: 'Patient' | 'ImagingStudy'
): Option.Option<SourceFile.Subject> =>
  Arr.findFirst(
    DecodedFile.resources(decoded),
    (entry) => entry.resource.resourceType === resourceType
  ).pipe(
    Option.flatMap((entry) => Option.fromNullable(entry.resource.id)),
    Option.map((id) => ({ reference: `${resourceType}/${id}` }))
  )

/**
 * Decode one study's picked files into a section of adopted, labeled FHIR
 * resources.
 *
 * @param members - Every picked `.dcm` of one study, in study order, each with
 *   its parsed header and the reference to its archive (what the instance's
 *   `gridfsFileId` extension names)
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against
 * @returns One section when the study carries a patient, plus notes for what
 *   could not be extracted and what each file contributed; fails with a
 *   `ParseError` when the time zone is not one the runtime resolves or a
 *   synthesized resource does not satisfy its schema
 *
 * @remarks
 * The resource keys are fixed — `patient`, `service-request`,
 * `imaging-study` — and are unique only *within* one study; the decode
 * function namespaces them by the set's representative pick.
 *
 * The time zone is rejected rather than substituted — a guess would write
 * `started` instants hours from what the equipment recorded — and it is one
 * setting for the whole pick, so an unresolvable zone fails every set.
 */
const decodeStudy = (
  members: Arr.NonEmptyReadonlyArray<StudyMember>,
  settings: DicomSettings
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  Effect.gen(function* () {
    yield* checkTimeZone(settings.timeZone)

    const files: readonly StudyFile[] = members.map((member) => ({
      file: member.file,
      header: member.header,
      sourceFileId: SourceFile.idFromReference(member.sourceFile),
    }))
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

export { archiveLinks, decodeStudy, partitionStudies, sectionTitle, studyKey }
export type { ParsedFile, StudyFileSet, StudyMember }
