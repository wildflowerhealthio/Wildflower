/**
 * The FHIR encoding of an uploaded DICOM file as a `DocumentReference`.
 *
 * @remarks
 * The source file codec: a whole `.dcm` file lives as one attachment, keyed
 * under the `dicom-source-file` category. Every FHIR resource a future D3
 * decode writes will stamp this source file's reference onto `meta.source` —
 * the provenance link that lets a reader trace a `ServiceRequest` or
 * `ImagingStudy` back to the raw DICOM file it came from.
 *
 * @packageDocumentation
 */
export {
  buildSourceFile,
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
} from './dicom-source-file-codec.ts'
export { DICOM_SYSTEM } from '../source-system.ts'
