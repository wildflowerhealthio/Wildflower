/**
 * Pure DICOM Part 10 tag reader: {@link parseDicomFile} wraps `dicom-parser`
 * into a typed {@link DicomHeader}, and the {@link TransferSyntax} /
 * {@link SopClass} / {@link PlanarConfiguration} / {@link PixelRepresentation}
 * namespaces put a human-readable name to the enumerated values it carries.
 *
 * @packageDocumentation
 */
export * as PixelRepresentation from './pixel-representation.ts'
export * as PlanarConfiguration from './planar-configuration.ts'
export * as SopClass from './sop-class.ts'
export * as TransferSyntax from './transfer-syntax.ts'
// Namespaced symbols are reached through their namespace above. The three
// models below are plain types with no operations to namespace, and
// `parse-dicom-file.ts` is not a namespace either, so both export flat.
export type { DicomHeader } from './dicom-header.ts'
export type { PersonName } from './person-name.ts'
export type { PixelDataDescription } from './pixel-data-description.ts'
export { parsePersonName, parseDicomFile, type DicomParseError } from './parse-dicom-file.ts'
