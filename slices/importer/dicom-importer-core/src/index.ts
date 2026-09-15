/**
 * The DICOM binding of the importer slice (core layer): DICOM tag parsing
 * via the `dicom` file-formats package, FHIR R4 synthesis (Patient,
 * ServiceRequest, ImagingStudy), byte-level `.dcm` detection, and the
 * source file codec. No DOM, no `fs`, no React.
 *
 * @packageDocumentation
 */
export { decodeDicom } from './decode.ts'
export { detectDicom } from './detect.ts'
export { dicomImporterDescriptor } from './descriptor.ts'
export { toFhirResources, patientOriginalId } from './fhir/to-fhir.ts'
export { buildSourceFile } from './source-file/index.ts'
export { defaultDicomSettings, type DicomSettings } from './settings.ts'
export { DICOM_SYSTEM } from './source-system.ts'
