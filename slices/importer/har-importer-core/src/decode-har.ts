import { Effect, type ParseResult, Schema } from 'effect'

import type { Extraction } from 'http-extraction-fundamentals'
import { HttpArchive } from './har/index.ts'

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
  status: entry.status,
  statusText: entry.statusText,
  headers: entry.headers,
  startedAt: entry.startedAt,
  body: entry.body,
  bodyAbsent: entry.bodyAbsent,
})

/**
 * Decode a `.har` file's text into the structural responses the recognizer
 * reads — the read half's only step, with nothing written.
 *
 * @param fileText - The text of a `.har` file
 * @param _settings - The HAR settings (none today; accepted so the signature
 *   matches `FileImporterDescriptor.decode`)
 * @returns The archive's entries as `Extraction.Input`s, failing only with a
 *   `ParseError` when the text is not a well-formed HTTP Archive; requires
 *   nothing, so the write client is unreachable from a decode by construction
 */
const decodeHar = (
  fileText: string,
  _settings: HarSettings
): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError> =>
  Schema.decodeUnknown(HttpArchive.LogFromHarJson)(fileText).pipe(
    Effect.map((log) => log.entries.map(toInput))
  )

export { decodeHar, toInput }
