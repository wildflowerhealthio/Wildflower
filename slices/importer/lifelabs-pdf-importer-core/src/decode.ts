import { DateTime, Effect, Option, type ParseResult, Schema } from 'effect'
import { Document } from 'positioned-text'

import type { Extraction } from 'http-extraction-fundamentals'

import type { LifeLabsPdfSettings } from './settings.ts'

/**
 * The URL a positioned-text document is presented under to the recognizer —
 * an import has no HTTP origin, so the binding mints one under Wildflower's
 * own host, keyed by the file's name. `LifeLabsReportResponseKind` claims
 * exactly this prefix.
 */
const LIFELABS_PDF_URL_PREFIX = 'https://wildflowerhealth.io/import/lifelabs-pdf/'

/**
 * The header the decoded response carries the time-zone setting in, so the
 * response kind's `parse` — which sees the response, not the settings — reads
 * the zone the reviewer chose.
 */
const TIME_ZONE_HEADER = 'x-wildflower-time-zone'

const utf8 = new TextEncoder()

const decodeDocument = Schema.decodeUnknown(Document.FromJson)

/**
 * Decode a positioned-text JSON file into the one structural response the
 * recognizer reads — the read half's only step, with nothing written.
 *
 * @param fileText - The text of a `wildflower-positioned-text` JSON file (what
 *   the PDF anonymizer downloads for a LifeLabs report)
 * @param settings - The import's settings; the time zone rides on the
 *   response as the `x-wildflower-time-zone` header
 * @returns One `Extraction.Input` carrying the file verbatim as its body,
 *   under a `https://wildflowerhealth.io/import/lifelabs-pdf/<file>` URL;
 *   fails only with a `ParseError` when the text is not a positioned-text
 *   document; requires nothing, so the write client is unreachable from a
 *   decode by construction
 */
const decodeLifeLabsPdf = (
  fileText: string,
  settings: LifeLabsPdfSettings
): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const document = yield* decodeDocument(fileText)
    const fileName = document.fileName ?? 'report.json'
    const startedAt = yield* DateTime.now
    const input: Extraction.Input = {
      id: `lifelabs-pdf:${fileName}`,
      url: `${LIFELABS_PDF_URL_PREFIX}${encodeURIComponent(fileName)}`,
      method: Option.some('GET'),
      status: 200,
      statusText: 'OK',
      headers: [
        ['content-type', 'application/json'],
        [TIME_ZONE_HEADER, settings.timeZone],
      ],
      startedAt,
      body: utf8.encode(fileText),
      bodyAbsent: false,
    }
    return [input]
  })

export { decodeLifeLabsPdf, LIFELABS_PDF_URL_PREFIX, TIME_ZONE_HEADER }
