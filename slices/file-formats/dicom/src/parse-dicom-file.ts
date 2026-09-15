import { parseDicom, type DataSet } from 'dicom-parser'
/**
 * Parse a DICOM Part 10 file's bytes into a typed {@link DicomHeader},
 * wrapping `dicom-parser` into an `Either`.
 *
 * @packageDocumentation
 */
import { Either } from 'effect'

import type { DicomHeader, PersonName } from './dicom-header.ts'

/** The tag addresses used below, named for readability. */
const Tag = {
  // Patient
  PatientName: 'x00100010',
  PatientID: 'x00100020',
  IssuerOfPatientID: 'x00100021',
  PatientBirthDate: 'x00100030',
  PatientSex: 'x00100040',
  // Study
  StudyInstanceUID: 'x0020000d',
  StudyDate: 'x00080020',
  StudyTime: 'x00080030',
  StudyDescription: 'x00081030',
  AccessionNumber: 'x00080050',
  ReferringPhysicianName: 'x00080090',
  RequestedProcedureDescription: 'x00321060',
  RequestAttributesSequence: 'x00400275',
  // Series
  SeriesInstanceUID: 'x0020000e',
  SeriesNumber: 'x00200011',
  SeriesDescription: 'x0008103e',
  Modality: 'x00080060',
  BodyPartExamined: 'x00180015',
  // Instance
  SOPInstanceUID: 'x00080018',
  SOPClassUID: 'x00080016',
  InstanceNumber: 'x00200013',
  Rows: 'x00280010',
  Columns: 'x00280011',
  NumberOfFrames: 'x00280008',
  TransferSyntaxUID: 'x00020010',
  // Equipment
  Manufacturer: 'x00080070',
  ManufacturerModelName: 'x00081090',
  InstitutionName: 'x00080080',
} as const

/** A reason `parseDicomFile` could not read the bytes. */
interface DicomParseError {
  readonly reason: string
}

/**
 * Parse a DICOM PN (Person Name) value. The PN grammar is
 * `family^given^middle^prefix^suffix` with `^` separating components.
 * Only family and given are extracted; the rest folds into `text`.
 */
const parsePersonName = (raw: string): PersonName | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const components = trimmed.split('^')
  const family = (components[0] ?? '').trim()
  const given = (components[1] ?? '').trim()
  const text = components
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(' ')
  return { family, given, text }
}

/**
 * Read a DICOM DA (Date) string. DA is `YYYYMMDD` — we keep it as-is for
 * the header; the FHIR synthesis interprets it.
 */
const readDa = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.trim() || undefined
}

/** Read a DICOM TM (Time) string, trimmed. */
const readTm = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.trim() || undefined
}

/** Read a DICOM UI (UID) string, trimmed of padding nulls and spaces. */
const readUi = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  // UIDs are padded with null characters per the DICOM spec
  return value === undefined ? undefined : value.replaceAll('\0', '').trim() || undefined
}

/** Read a plain string tag, trimmed. */
const readString = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.trim() || undefined
}

/** Read a PN tag as a PersonName. */
const readPn = (dataSet: DataSet, tag: string): PersonName | undefined => {
  const value = dataSet.string(tag)
  if (value === undefined) return undefined
  return parsePersonName(value)
}

/**
 * Parse a DICOM Part 10 file's raw bytes into a typed {@link DicomHeader}.
 *
 * @param bytes - The raw bytes of a `.dcm` file, preamble included
 * @returns `Right(DicomHeader)` on success, `Left(DicomParseError)` when the
 *   file cannot be parsed or is missing a required UID
 */
const parseDicomFile = (bytes: Uint8Array): Either.Either<DicomHeader, DicomParseError> => {
  let dataSet: DataSet
  try {
    dataSet = parseDicom(bytes)
  } catch (error) {
    return Either.left({
      reason: error instanceof Error ? error.message : 'DICOM parse failed',
    })
  }

  const studyInstanceUid = readUi(dataSet, Tag.StudyInstanceUID)
  const seriesInstanceUid = readUi(dataSet, Tag.SeriesInstanceUID)
  const sopInstanceUid = readUi(dataSet, Tag.SOPInstanceUID)

  if (studyInstanceUid === undefined) {
    return Either.left({ reason: 'Missing StudyInstanceUID (0020,000D)' })
  }
  if (seriesInstanceUid === undefined) {
    return Either.left({ reason: 'Missing SeriesInstanceUID (0020,000E)' })
  }
  if (sopInstanceUid === undefined) {
    return Either.left({ reason: 'Missing SOPInstanceUID (0008,0018)' })
  }

  const hasRequestAttributesSequence = dataSet.elements[Tag.RequestAttributesSequence] !== undefined

  const header: DicomHeader = {
    patientName: readPn(dataSet, Tag.PatientName),
    patientId: readString(dataSet, Tag.PatientID),
    issuerOfPatientId: readString(dataSet, Tag.IssuerOfPatientID),
    patientBirthDate: readDa(dataSet, Tag.PatientBirthDate),
    patientSex: readString(dataSet, Tag.PatientSex),

    studyInstanceUid,
    studyDate: readDa(dataSet, Tag.StudyDate),
    studyTime: readTm(dataSet, Tag.StudyTime),
    accessionNumber: readString(dataSet, Tag.AccessionNumber),
    studyDescription: readString(dataSet, Tag.StudyDescription),
    referringPhysicianName: readPn(dataSet, Tag.ReferringPhysicianName),
    requestedProcedureDescription: readString(dataSet, Tag.RequestedProcedureDescription),
    hasRequestAttributesSequence,

    seriesInstanceUid,
    seriesNumber: dataSet.intString(Tag.SeriesNumber) ?? undefined,
    seriesDescription: readString(dataSet, Tag.SeriesDescription),
    modality: readString(dataSet, Tag.Modality),
    bodyPartExamined: readString(dataSet, Tag.BodyPartExamined),

    sopInstanceUid,
    sopClassUid: readUi(dataSet, Tag.SOPClassUID),
    instanceNumber: dataSet.intString(Tag.InstanceNumber) ?? undefined,
    rows: dataSet.uint16(Tag.Rows) ?? undefined,
    columns: dataSet.uint16(Tag.Columns) ?? undefined,
    numberOfFrames: dataSet.intString(Tag.NumberOfFrames) ?? undefined,
    transferSyntaxUid: readUi(dataSet, Tag.TransferSyntaxUID),

    manufacturer: readString(dataSet, Tag.Manufacturer),
    manufacturerModelName: readString(dataSet, Tag.ManufacturerModelName),
    institutionName: readString(dataSet, Tag.InstitutionName),
  }

  return Either.right(header)
}

export { parsePersonName, parseDicomFile, type DicomParseError }
