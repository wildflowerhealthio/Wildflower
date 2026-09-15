/**
 * Pure DICOM Part 10 tag reader: {@link parseDicomFile} wraps `dicom-parser`
 * into a typed {@link DicomHeader} of the tags the importer cares about.
 *
 * @remarks
 * No DOM, no `fs`, no React, no extraction library — a raw `.dcm` file's
 * bytes in, a typed view of its tags out. The importer binding's FHIR
 * synthesis lives above this package; this one reads and stops.
 *
 * @packageDocumentation
 */
export type { DicomHeader, PersonName } from './dicom-header.ts'
export { parsePersonName, parseDicomFile, type DicomParseError } from './parse-dicom-file.ts'
