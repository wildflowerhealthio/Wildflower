/**
 * The export boundary's redactor: shape-preserving pseudonymization of a
 * captured session.
 *
 * @remarks
 * Capture is lossless and the viewer shows raw data — it is the user's own
 * device and their own data. This module is the one place where that stops being
 * true, so a change here changes what leaves the device. Treat it accordingly.
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
export {
  BODY_HASH_PATH,
  bodyPath,
  cookieAttributePath,
  cookiePath,
  headerPath,
  isJsonContentType,
  type JsonLeaf,
  type LeafVisitor,
  looksLikeIdentifier,
  mapExchangeLeaves,
  pathTemplate,
  queryPath,
  urlSegmentPath,
} from './leaves.ts'
export {
  buildRedactionPolicy,
  CODE_TOKEN_MAX_LENGTH,
  DEFAULT_ENUM_THRESHOLD,
  type EnumDecision,
  isCodeToken,
  type PathOverride,
  type PathStat,
  PseudonymSpaceExhausted,
  redactExchange,
  type RedactionError,
  type RedactionOptions,
  type RedactionPolicy,
  redactSession,
} from './redact.ts'
export { detectShape, generateFake, type LeafShape } from './shapes.ts'
