/**
 * Pure DICOM Part 10 tag reader: {@link parseDicomFile} wraps `dicom-parser`
 * into a typed {@link DicomHeader}, and {@link transferSyntaxName} /
 * {@link sopClassName} put a human-readable name to the UIDs it carries.
 *
 * @packageDocumentation
 */
export type { DicomHeader, PersonName, PixelDataDescription } from './dicom-header.ts'
export { parsePersonName, parseDicomFile, type DicomParseError } from './parse-dicom-file.ts'
export { sopClassName, transferSyntaxName } from './uid-names.ts'
