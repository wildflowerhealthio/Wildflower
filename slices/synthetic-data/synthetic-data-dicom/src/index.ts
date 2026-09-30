/**
 * The DICOM synthetic data generator: a real, already de-identified DICOM
 * image re-identified as a person in a `synthetic-data-fundamentals/story`
 * story (`DicomImage.reidentify`), and read back through the DICOM importer
 * onto the person's Patient from another source (`DicomImage.importWithSubject`).
 *
 * Deterministic: the same as-of day gives byte-identical output.
 *
 * @packageDocumentation
 */
export * as DicomImage from './dicom-image.ts'
