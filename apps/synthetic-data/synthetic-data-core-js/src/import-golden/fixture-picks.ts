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
 * response bodies, archived at the URLs the app fetches them from. Beside
 * them, a FHIR server's document and its `Binary`, whose bodies are written
 * here.
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

/** The base URL of the FHIR server the archived document session reads. */
const DOCUMENT_SERVER_BASE = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'

/** When the archived document session starts. */
const DOCUMENT_CAPTURE_START = DateTime.unsafeMake('2026-11-10T15:00:00Z')

/** One read of the archived document session, `millis` after it starts, answering `body` as `mimeType`. */
const documentReadOf = (
  path: string,
  mimeType: string,
  body: string,
  millis: number
): ChromeHar.Entry =>
  ChromeHar.entryOf({
    pageref: 'page_1',
    resourceType: 'xhr',
    startedAt: DateTime.add(DOCUMENT_CAPTURE_START, { millis }),
    url: `${DOCUMENT_SERVER_BASE}/${path}`,
    requestHeaders: [['accept', 'application/fhir+json']],
    mimeType,
    body,
    waitMillis: 100,
    serverIPAddress: '203.0.113.20',
  })

/** One read of the archived document session answering `resource` as FHIR JSON. */
const documentFhirReadOf = (path: string, resource: unknown, millis: number): ChromeHar.Entry =>
  documentReadOf(path, 'application/fhir+json', JSON.stringify(resource), millis)

/** The `Binary` the archived document session serves as FHIR JSON: a short plain-text note. */
const DOCUMENT_BINARY = {
  resourceType: 'Binary',
  id: 'bin-served',
  contentType: 'text/plain',
  data: btoa('Visit summary: no concerns.'),
}

/**
 * A session archive of a FHIR server's document and its `Binary`, every way
 * the importer treats one:
 *
 * - a Patient, and a DocumentReference filed on them, whose attachments name
 *   a Binary the session serves (relative, and absolute under the server's
 *   base), one it never serves, and one it serves only as its raw content,
 *   and whose `context.related` references the served Binary;
 * - the served Binary read as FHIR JSON, then read again under a query
 *   string;
 * - the last Binary read as its raw content.
 */
const fhirDocumentPick = (): Effect.Effect<PickedFile.NamedBytes, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const text = yield* chromeHarToJson(
      chromeHarOf(
        [
          chromePageOf({
            id: 'page_1',
            url: 'https://ehr.example.com/documents',
            startedAt: DOCUMENT_CAPTURE_START,
            onContentLoadMillis: 300,
            onLoadMillis: 900,
          }),
        ],
        [
          documentFhirReadOf(
            'Patient/eXYZ123',
            {
              resourceType: 'Patient',
              id: 'eXYZ123',
              name: [{ family: 'Smith', given: ['Jane'] }],
              gender: 'female',
            },
            1000
          ),
          documentFhirReadOf(
            'DocumentReference/doc-1',
            {
              resourceType: 'DocumentReference',
              id: 'doc-1',
              status: 'current',
              subject: { reference: 'Patient/eXYZ123' },
              content: [
                { attachment: { contentType: 'text/plain', url: 'Binary/bin-served' } },
                {
                  attachment: {
                    contentType: 'text/plain',
                    url: `${DOCUMENT_SERVER_BASE}/Binary/bin-served`,
                  },
                },
                { attachment: { contentType: 'application/pdf', url: 'Binary/bin-never-served' } },
                { attachment: { contentType: 'application/pdf', url: 'Binary/bin-raw' } },
              ],
              context: { related: [{ reference: 'Binary/bin-served' }] },
            },
            1200
          ),
          documentFhirReadOf('Binary/bin-served', DOCUMENT_BINARY, 1400),
          documentFhirReadOf('Binary/bin-served?_format=json', DOCUMENT_BINARY, 1600),
          documentReadOf('Binary/bin-raw', 'application/pdf', '%PDF-1.7 a raw body', 1800),
        ]
      ),
      { pretty: true }
    )
    return textPick('fhir-document.har', text)
  })

export { chromeFhirCapturePick, fhirDocumentPick, rexallFixturePick, textPick }
