/**
 * The coding axis an uploaded LifeLabs report PDF is stored under — the
 * `/source-file` subpath, so a reader building the cross-format search token
 * imports one narrow thing rather than this package's whole surface.
 *
 * @remarks
 * A narrowing of `source-system.ts`, which also holds
 * `LifeLabsIdentifierSystem` — used by the FHIR synthesis, and no part of this
 * seam.
 *
 * @packageDocumentation
 */
export {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
} from './source-system.ts'
