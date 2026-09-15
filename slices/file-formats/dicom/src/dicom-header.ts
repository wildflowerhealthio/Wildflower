/**
 * A typed view of the DICOM tags the importer cares about, decoded from
 * `dicom-parser`'s `DataSet`. Every field is optional except the three UIDs
 * (`StudyInstanceUID`, `SeriesInstanceUID`, `SOPInstanceUID`) — a file
 * missing any of those is a parse error, not a header with blanks.
 *
 * @packageDocumentation
 */

/** A parsed DICOM Person Name: family and given parts split from the `^` PN grammar. */
interface PersonName {
  readonly family: string
  readonly given: string
  readonly text: string
}

/**
 * The DICOM tags the importer reads, grouped by module. Every field is
 * optional except the three instance UIDs.
 */
interface DicomHeader {
  // Patient module
  readonly patientName: PersonName | undefined
  readonly patientId: string | undefined
  readonly issuerOfPatientId: string | undefined
  readonly patientBirthDate: string | undefined
  readonly patientSex: string | undefined

  // Study module
  readonly studyInstanceUid: string
  readonly studyDate: string | undefined
  readonly studyTime: string | undefined
  readonly studyDescription: string | undefined
  readonly accessionNumber: string | undefined
  readonly referringPhysicianName: PersonName | undefined
  readonly requestedProcedureDescription: string | undefined
  readonly hasRequestAttributesSequence: boolean

  // Series module
  readonly seriesInstanceUid: string
  readonly seriesNumber: number | undefined
  readonly seriesDescription: string | undefined
  readonly modality: string | undefined
  readonly bodyPartExamined: string | undefined

  // Instance module
  readonly sopInstanceUid: string
  readonly sopClassUid: string | undefined
  readonly instanceNumber: number | undefined
  readonly rows: number | undefined
  readonly columns: number | undefined
  readonly numberOfFrames: number | undefined
  readonly transferSyntaxUid: string | undefined

  // Equipment module
  readonly manufacturer: string | undefined
  readonly manufacturerModelName: string | undefined
  readonly institutionName: string | undefined
}

export type { DicomHeader, PersonName }
