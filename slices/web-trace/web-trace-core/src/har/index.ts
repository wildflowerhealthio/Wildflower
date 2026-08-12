/**
 * HAR 1.2, as one schema read in both directions: `emitHar` builds an archive
 * from captured exchanges, and an import reads one — including a foreign one —
 * as the exchanges a replay consumes.
 *
 * @packageDocumentation
 */
export {
  ARCHIVED_EXCHANGE_ID_PREFIX,
  ArchivedExchange,
  ArchivedSession,
  ArchivedSessionFromHar,
  ArchivedSessionFromHarJson,
  DROPPED_REQUEST_COMMENT,
  DROPPED_TIMINGS_COMMENT,
  fromHarJson,
  toHarJson,
} from './archived-exchange.ts'
export {
  CREATOR_NAME,
  type EmitHarOptions,
  emitHar,
  METHOD_COMMENT,
  REQUEST_COMMENT,
  SKIPPED_BODY_COMMENT,
} from './emit.ts'
export {
  BASE64_ENCODING,
  Har,
  HarBase64Body,
  HarBody,
  HarContent,
  HarCreator,
  HarEntry,
  HarFromJson,
  HarLog,
  HarNameValue,
  HarNoBody,
  HarRequest,
  HarResponse,
  HarTextBody,
  HarTimings,
  NOT_MEASURED,
} from './har.ts'
