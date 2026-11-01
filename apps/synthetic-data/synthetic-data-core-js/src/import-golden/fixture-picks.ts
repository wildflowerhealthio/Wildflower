import { chromeHarOf, chromeHarToJson, chromePageOf } from '@wildflowerhealthio/http-archive'
import type { PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { REXALL_PROFILE_URL } from '@wildflowerhealthio/rexall-be-well-source'
import { type Cause, DateTime, Effect, type ParseResult } from 'effect'

import * as ChromeHar from '@wildflowerhealthio/synthetic-data-fundamentals/chrome-har'

import rexallPrescriptions from '../../../../../slices/http-extraction/rexall-be-well-source/src/fixtures/prescriptions-searchset.json' with { type: 'json' }
import rexallProfile from '../../../../../slices/http-extraction/rexall-be-well-source/src/fixtures/profile-me.json' with { type: 'json' }
import chromeFhirCapture from '../../../../../slices/importer/har-importer-core/src/fixtures/chrome-fhir-capture.har.json' with { type: 'json' }

/**
 * The import golden pin's picks made of committed fixtures: the HAR
 * importer's Chrome capture of a FHIR server, and the Rexall Be Well source's
 * response bodies, archived at the URLs the app fetches them from.
 *
 * @packageDocumentation
 */

/** The pick of `text` under `fileName`. */
const textPick = (fileName: string, text: string): PickedFile.NamedBytes => ({
  fileName,
  bytes: new TextEncoder().encode(text),
})

/** The committed Chrome capture of a FHIR server: a Patient read and an Observation search. */
const chromeFhirCapturePick = (): PickedFile.NamedBytes =>
  textPick('chrome-fhir-capture.har', JSON.stringify(chromeFhirCapture, null, 2))

/** When the archived Rexall session starts. */
const REXALL_CAPTURE_START = DateTime.unsafeMake('2026-10-31T15:00:00Z')

/** One XHR of the archived Rexall session, `millis` after it starts, answering `body`. */
const rexallXhrOf = (url: string, body: unknown, millis: number): ChromeHar.Entry =>
  ChromeHar.entryOf({
    pageref: 'page_1',
    resourceType: 'xhr',
    startedAt: DateTime.add(REXALL_CAPTURE_START, { millis }),
    url,
    requestHeaders: [['accept', 'application/json, text/plain, */*']],
    mimeType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
    waitMillis: 100,
    serverIPAddress: '203.0.113.12',
  })

/**
 * The committed Rexall profile and prescriptions searchset, as a session
 * archive: each body at the URL it was captured from (the searchset's own
 * `self` link).
 */
const rexallFixturePick = (): Effect.Effect<
  PickedFile.NamedBytes,
  ParseResult.ParseError | Cause.NoSuchElementException
> =>
  Effect.gen(function* () {
    const searchsetUrl = yield* Effect.fromNullable(
      rexallPrescriptions.link.find(({ relation }) => relation === 'self')?.url
    )
    const text = yield* chromeHarToJson(
      chromeHarOf(
        [
          chromePageOf({
            id: 'page_1',
            url: 'https://app.letsbewell.ca/health/prescriptions',
            startedAt: REXALL_CAPTURE_START,
            onContentLoadMillis: 300,
            onLoadMillis: 900,
          }),
        ],
        [
          rexallXhrOf(REXALL_PROFILE_URL, rexallProfile, 1000),
          rexallXhrOf(searchsetUrl, rexallPrescriptions, 1200),
        ]
      ),
      { pretty: true }
    )
    return textPick('rexall-fixtures.har', text)
  })

export { chromeFhirCapturePick, rexallFixturePick, textPick }
