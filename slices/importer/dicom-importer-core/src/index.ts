/**
 * The DICOM binding of the importer slice (core layer): the byte-level
 * detection that identifies a `.dcm` file, the archive codec that stores
 * it as a FHIR `DocumentReference`, and the importer descriptor. No DICOM
 * tag parsing — D3 fills that in.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `.dcm` file's raw bytes in, stored as an
 * archive, zero extracted resources out (one note says the contents are not
 * read yet). The decode yields zero sections so the review screen is honest
 * about what confirm will do.
 *
 * @packageDocumentation
 */
export { decodeDicom } from './decode.ts'
export { detectDicom } from './detect.ts'
export { dicomImporterDescriptor } from './descriptor.ts'
export { sourceArchive } from './archive/index.ts'
export { defaultDicomSettings, type DicomSettings } from './settings.ts'
export { DICOM_SYSTEM } from './source-system.ts'
