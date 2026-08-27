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
 * An {@link ArchivedExchange} and an `Extraction.Input` line up field-for-field —
 * `id`/`url`/`status`/`statusText`/`headers`/`startedAt`/`body`/`bodyAbsent`,
 * with `ArchivedExchange`'s `headers` (`HeadersWire`, an ordered `[name, value]`
 * list) being exactly `HttpResponse.Headers`. Restated explicitly rather than
 * passed through so a drift in either shape is a compile error here, at the one
 * seam the two packages meet — neither `web-trace-core` nor
 * `http-extraction-fundamentals` imports the other, so this is the only place
 * their alignment is checked.
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
 *   `ParseError` when the text is not a well-formed HAR archive
 *
 * @remarks
 * `fromHarJson` decodes the archive into an `ArchivedSession`; each
 * `ArchivedExchange` is restated as an `Extraction.Input` via {@link toInput}.
 * The Effect requires nothing — reading a file into responses is a pure function
 * of its text, so the write client is unreachable from a decode by construction.
 */
const decodeHar = (
  fileText: string,
  _settings: HarSettings
): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError> =>
  fromHarJson(fileText).pipe(Effect.map((session) => session.exchanges.map(toInput)))

export { decodeHar, toInput }
