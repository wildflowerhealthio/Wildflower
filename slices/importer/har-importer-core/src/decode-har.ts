import { Effect, Option, type ParseResult, Schema } from 'effect'

import { HttpArchive } from 'http-archive'
import type { Extraction } from 'http-extraction-fundamentals'

import type { HarSettings } from './har-settings.ts'

/**
 * One archive entry as the structural {@link Extraction.Input} the recognizer
 * consumes.
 *
 * @param entry - An entry read out of the HTTP Archive
 * @returns The same eight fields, typed as an `Extraction.Input`
 *
 * @remarks
 * Restated field-for-field rather than passed through, so a drift in either
 * shape is a compile error here — the one seam the two packages (neither of
 * which imports the other) meet.
 */
const toInput = (entry: HttpArchive.Entry): Extraction.Input => ({
  id: entry.id,
  url: entry.url,
  // `HttpArchive.Entry` carries the wire `HarMethodValue` (the seven verbs
  // plus `'UNKNOWN'`); the extraction pipeline speaks `Option<HttpMethod>`,
  // with `Option.none()` standing in for a HAR entry whose method the
  // archive dropped. This is the one boundary where the wire↔option
  // conversion happens.
  method: entry.method === 'UNKNOWN' ? Option.none() : Option.some(entry.method),
  status: entry.status,
  statusText: entry.statusText,
  headers: entry.headers,
  startedAt: entry.startedAt,
  body: entry.body,
  bodyAbsent: entry.bodyAbsent,
})

/** Single UTF-8 decoder, reused across pick decodes. */
const utf8 = new TextDecoder()

/**
 * Decode a `.har` file's bytes into the structural responses the recognizer
 * reads — the read half's only step, with nothing written.
 *
 * @param fileBytes - The bytes of a `.har` file (UTF-8 JSON)
 * @param _settings - The HAR settings (none today; accepted so the signature
 *   matches the importer's `decodeFileSet`)
 * @returns The archive's entries as `Extraction.Input`s, failing only with a
 *   `ParseError` when the bytes are not a well-formed HTTP Archive; requires
 *   nothing, so the write client is unreachable from a decode by construction
 */
const decodeHar = (
  fileBytes: Uint8Array,
  _settings: HarSettings
): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError> =>
  Schema.decodeUnknown(HttpArchive.LogFromHarJson)(utf8.decode(fileBytes)).pipe(
    Effect.map((log) => log.entries.map(toInput))
  )

export { decodeHar, toInput }
