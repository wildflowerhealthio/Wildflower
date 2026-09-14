/**
 * The FHIR encoding of an uploaded DICOM file as a `DocumentReference`.
 *
 * @remarks
 * The archive codec: a whole `.dcm` file lives as one attachment, keyed under
 * the `dicom-archive` category. Every FHIR resource a future D3 decode writes
 * will stamp this archive's reference onto `meta.source` — the provenance link
 * that lets a reader trace a `ServiceRequest` or `ImagingStudy` back to the
 * raw DICOM file it came from.
 *
 * @packageDocumentation
 */
export {
  DICOM_ARCHIVE_CATEGORY_TOKEN,
  DICOM_ARCHIVE_CODE,
  DICOM_ARCHIVE_CONTENT_TYPE,
  dicomArchiveFromDocumentReference,
  isDicomArchive,
  sourceArchive,
} from './dicom-archive-codec.ts'
export { DICOM_SYSTEM } from '../source-system.ts'
