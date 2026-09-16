/**
 * Pure DICOM Part 10 tag reader: {@link parseDicomFile} wraps `dicom-parser`
 * into a typed {@link DicomHeader}.
 *
 * @packageDocumentation
 */
export type { DicomHeader, PersonName } from './dicom-header.ts'
export { parsePersonName, parseDicomFile, type DicomParseError } from './parse-dicom-file.ts'
