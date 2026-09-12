/**
 * The FHIR encoding of an uploaded LifeLabs report PDF as a
 * `DocumentReference`.
 *
 * @remarks
 * The archive codec: a whole PDF file lives as one attachment, keyed under
 * the `lifelabs-pdf-archive` category. Every FHIR resource this importer
 * writes stamps this archive's reference onto `meta.source` — the
 * provenance link that lets a reader trace a `Patient`,
 * `DiagnosticReport`, or `Observation` back to the raw PDF it came from.
 *
 * @packageDocumentation
 */
export {
  isLifeLabsPdfArchive,
  LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN,
  LIFELABS_PDF_ARCHIVE_CODE,
  LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
  LifeLabsPdfArchive,
  LifeLabsPdfArchiveFromDocumentReference,
  LifeLabsPdfArchiveFromFhirJson,
  lifeLabsPdfArchiveFromDocumentReference,
  LifeLabsPdfArchiveId,
  lifeLabsPdfArchiveToDocumentReference,
  lifeLabsPdfArchiveToWire,
} from './lifelabs-pdf-archive-codec.ts'
export { LIFELABS_SYSTEM } from '../source-system.ts'
