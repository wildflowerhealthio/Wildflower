import { Effect, type ParseResult } from 'effect'

import type { Extraction } from 'http-extraction-fundamentals'
import { type ArchivedExchange, fromHarJson } from 'web-trace-core/har'

import type { HarSettings } from './har-settings.ts'

/**
 * One archived exchange as the structural {@link Extraction.Input} the
 * recognizer consumes.
 *
 * @param exchange - An exchange read out of the HAR archive
 * @returns The same eight fields, typed as an `Extraction.Input`
 *
 * @remarks
 * Restated field-for-field rather than passed through, so a drift in either
 * shape is a compile error here — the one seam the two packages (neither of
 * which imports the other) meet.
 */
const toInput = (exchange: ArchivedExchange): Extraction.Input => ({
  id: exchange.id,
  url: exchange.url,
  status: exchange.status,
  statusText: exchange.statusText,
  headers: exchange.headers,
  startedAt: exchange.startedAt,
  body: exchange.body,
  bodyAbsent: exchange.bodyAbsent,
})

/**
 * Decode a `.har` file's text into the structural responses the recognizer
 * reads — the read half's only step, with nothing written.
 *
 * @param fileText - The text of a `.har` file
 * @param _settings - The HAR settings (none today; accepted so the signature
 *   matches `FileImporterDescriptor.decode`)
 * @returns The archive's exchanges as `Extraction.Input`s, failing only with a
 *   `ParseError` when the text is not a well-formed HAR archive; requires
 *   nothing, so the write client is unreachable from a decode by construction
 */
const decodeHar = (
  fileText: string,
  _settings: HarSettings
): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError> =>
  fromHarJson(fileText).pipe(Effect.map((session) => session.exchanges.map(toInput)))

export { decodeHar, toInput }
