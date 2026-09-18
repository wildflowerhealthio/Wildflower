/**
 * The coding axis an uploaded `.dcm` file is stored under — the `/source-file`
 * subpath, so a reader building the cross-format search token imports one
 * narrow thing rather than this package's whole surface.
 *
 * @remarks
 * A narrowing of `source-system.ts`, which also holds constants the synthesis
 * uses and this seam has no business exposing.
 *
 * @packageDocumentation
 */
export {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'
