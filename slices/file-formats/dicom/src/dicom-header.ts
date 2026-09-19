/**
 * The DICOM tags this package reads, as one typed record.
 *
 * @packageDocumentation
 */

import type { PersonName } from './person-name.ts'
import type { PixelDataDescription } from './pixel-data-description.ts'

/**
 * The DICOM tags this package reads, grouped by module.
 *
 * @remarks
 * Two audiences share one type. The Patient, Study, Series, Instance and
 * Equipment modules are what `dicom-importer-core` synthesizes FHIR from. The
 * Image Pixel module and {@link DicomHeader.pixelData} are read by nothing in
 * that synthesis — they exist so a preview can explain why a file did not
 * render.
 *
 * Every field is optional except the three instance UIDs, which a file must
 * carry to parse at all, and the two that describe the parse rather than a
 * tag: `hasRequestAttributesSequence` and `parserWarnings`.
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

  // Image Pixel module — how the frames are encoded, for decode debugging
  readonly samplesPerPixel: number | undefined
  readonly photometricInterpretation: string | undefined
  /** See `PlanarConfiguration.meaning` for the enumerated values. */
  readonly planarConfiguration: number | undefined
  readonly bitsAllocated: number | undefined
  readonly bitsStored: number | undefined
  readonly highBit: number | undefined
  /** See `PixelRepresentation.meaning` for the enumerated values. */
  readonly pixelRepresentation: number | undefined
  readonly rescaleIntercept: number | undefined
  readonly rescaleSlope: number | undefined
  /**
   * Window Center (0028,1050) and Width (0028,1051) as the raw DS values,
   * backslash separators and all — both are VM 1-n, and a file carrying the
   * several presets a viewer offers is exactly the case worth seeing whole.
   * The rescale pair beside them is VM 1, so it reads back as a number.
   */
  readonly windowCenter: string | undefined
  readonly windowWidth: string | undefined
  readonly pixelData: PixelDataDescription | undefined

  // Equipment module
  readonly manufacturer: string | undefined
  readonly manufacturerModelName: string | undefined
  readonly institutionName: string | undefined

  /**
   * What `dicom-parser` complained about while still returning a dataset —
   * an unexpected tag inside the pixel data, a missing sequence delimiter.
   * Empty for a well-formed file.
   */
  readonly parserWarnings: readonly string[]
}

export type { DicomHeader }
