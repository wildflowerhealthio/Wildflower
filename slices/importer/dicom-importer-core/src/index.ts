/**
 * The DICOM binding of the importer slice (core layer): DICOM tag parsing
 * via the `dicom` file-formats package, FHIR R4 synthesis (Patient,
 * ServiceRequest, ImagingStudy), byte-level `.dcm` detection, and the
 * source-file coding. No DOM, no `fs`, no React.
 *
 * @packageDocumentation
 */
export {
  linkToPatientAndStudy,
  decodeStudy,
  sectionTitle,
  studyGroupKey,
  studyKey,
  type StudyFile,
} from './decode.ts'
export { detectDicom } from './detect.ts'
export { dicomImporter } from './dicom-importer.ts'
export {
  accessionNumbers,
  orderedInstances,
  patientOriginalId,
  studySeries,
  toFhirResources,
  type StudyInstance,
  type StudySeries,
} from './fhir/to-fhir.ts'
export { dicomCalendarDate, dicomInstant } from './fhir/dates.ts'
export { defaultDicomSettings, runtimeTimeZone, type DicomSettings } from './settings.ts'
export {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'
