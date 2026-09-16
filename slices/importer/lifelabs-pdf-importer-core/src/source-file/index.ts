/**
 * The FHIR encoding of an uploaded LifeLabs report PDF as a
 * `DocumentReference`.
 *
 * @remarks
 * The source file codec: a whole PDF file lives as one attachment, keyed under
 * the `lifelabs-pdf-archive` category. Every FHIR resource this importer
 * writes stamps this source file's reference onto `meta.source` — the
 * provenance link that lets a reader trace a `Patient`,
 * `DiagnosticReport`, or `Observation` back to the raw PDF it came from.
 *
 * @packageDocumentation
 */
export {
  buildSourceFile,
  isLifeLabsPdfSourceFile,
  LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  lifeLabsPdfSourceFileCodec,
  lifeLabsPdfSourceFileFromDocumentReference,
} from './lifelabs-pdf-source-file-codec.ts'
export { LIFELABS_SYSTEM } from '../source-system.ts'
