/**
 * The primitives the export boundary's redactor is built from: shape detection,
 * same-shape fake generation, and the keyed hash every fake is derived from.
 *
 * @remarks
 * Capture is lossless and the viewer shows raw data — it is the user's own
 * device and their own data. This module is where that stops being true, so a
 * change here changes what leaves the device.
 *
 * @packageDocumentation
 */
export {
  hmac,
  importExportKey,
  type ExportKey,
  mintExportSalt,
  WebCryptoUnavailable,
} from './hmac.ts'
export { detectShape, generateFake, type LeafShape } from './shapes.ts'
