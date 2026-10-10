import {
  CHROME_CREATOR,
  type ChromePageSpec,
  type ChromeResourceType,
  chromeHarFromJson,
  chromeHarOf,
  chromeHarToJson,
  chromePageOf,
} from '@wildflowerhealthio/http-archive'
import { utf8Bytes } from '@wildflowerhealthio/kitchen-sink'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
// oxlint-disable no-underscore-dangle -- `_initiator`, `_priority` and `_resourceType` are the exact keys a DevTools export writes; these tests read them back.
import { DateTime, Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as ChromeHar from './chrome-har.ts'
import { asOfArbitrary } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

const nameArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/)

const urlArbitrary: fc.Arbitrary<string> = fc
  .record({
    path: fc.array(nameArbitrary, { maxLength: 3 }),
    query: fc.array(fc.tuple(nameArbitrary, fc.string()), { maxLength: 3 }),
  })
  .map(({ path, query }) => {
    const url = new URL(`https://portal.example.org/${path.join('/')}`)
    for (const [name, value] of query) url.searchParams.append(name, value)
    return url.href
  })

const pageSpecArbitrary = (id: string): fc.Arbitrary<ChromePageSpec> =>
  fc.record({
    id: fc.constant(id),
    url: urlArbitrary,
    startedAt: asOfArbitrary,
    onContentLoadMillis: fc.integer({ min: 1, max: 5000 }),
    onLoadMillis: fc.integer({ min: 1, max: 5000 }),
  })

const exchangeSpecArbitrary = (pageref: string): fc.Arbitrary<ChromeHar.ExchangeSpec> =>
  fc.record({
    pageref: fc.constant(pageref),
    resourceType: fc.constantFrom<ChromeResourceType>('document', 'xhr', 'fetch'),
    startedAt: asOfArbitrary,
    url: urlArbitrary,
    requestHeaders: fc.array(fc.tuple(nameArbitrary, fc.string()), { maxLength: 3 }),
    mimeType: fc.constantFrom('application/json', 'text/html; charset=utf-8'),
    body: fc.string({ unit: 'grapheme' }),
    waitMillis: fc.integer({ min: 0, max: 2000 }),
    serverIPAddress: fc.ipV4(),
  })

/** A capture of one or two pages, each with a few exchanges pointing back at it. */
const captureArbitrary = fc
  .array(nameArbitrary, { minLength: 1, maxLength: 2 })
  .map((ids) => [...new Set(ids)])
  .chain((pageIds) =>
    fc.record({
      pages: fc.tuple(...pageIds.map(pageSpecArbitrary)),
      exchanges: fc
        .constantFrom(...pageIds)
        .chain((pageId) => fc.array(exchangeSpecArbitrary(pageId), { minLength: 1, maxLength: 4 })),
    })
  )

describe('ChromeHar', () => {
  test('property: an archive writes to text that `http-archive` reads back unchanged', () => {
    fc.assert(
      fc.property(captureArbitrary, ({ pages, exchanges }) => {
        const archive = chromeHarOf(pages.map(chromePageOf), exchanges.map(ChromeHar.entryOf))
        const text = Effect.runSync(chromeHarToJson(archive, { pretty: true }))
        expect(Effect.runSync(chromeHarFromJson(text))).toEqual(archive)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: a navigation is initiated by the browser, an XHR or fetch by a script', () => {
    fc.assert(
      fc.property(exchangeSpecArbitrary('page_1'), (spec) => {
        const entry = ChromeHar.entryOf(spec)
        expect(entry._resourceType).toBe(spec.resourceType)
        expect({ initiator: entry._initiator.type, priority: entry._priority }).toEqual(
          spec.resourceType === 'document'
            ? { initiator: 'other', priority: 'VeryHigh' }
            : { initiator: 'script', priority: 'High' }
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('property: an entry records its body as UTF-8 text and its time as the sum of its phases', () => {
    fc.assert(
      fc.property(exchangeSpecArbitrary('page_1'), (spec) => {
        const entry = ChromeHar.entryOf(spec)
        const bytes = utf8Bytes(spec.body).length
        expect(entry.response.content).toEqual({
          size: bytes,
          mimeType: spec.mimeType,
          body: { _tag: 'HarTextBody', text: spec.body },
        })
        expect(entry.response.bodySize).toBe(bytes)
        expect(entry.response.headers).toEqual([['content-type', spec.mimeType]])
        const { blocked = 0, send, wait, receive } = entry.timings
        expect(wait).toBe(spec.waitMillis)
        expect(entry.time).toBeCloseTo(blocked + send + wait + receive)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: an entry lists its URL query parameters in order', () => {
    fc.assert(
      fc.property(exchangeSpecArbitrary('page_1'), (spec) => {
        expect(ChromeHar.entryOf(spec).request.queryString).toEqual(
          [...new URL(spec.url).searchParams].map(([name, value]) => ({ name, value }))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('property: an entry is a 200 GET over a reused HTTP/2 connection', () => {
    fc.assert(
      fc.property(exchangeSpecArbitrary('page_1'), (spec) => {
        const entry = ChromeHar.entryOf(spec)
        expect(entry.request.method).toBe('GET')
        expect(entry.response.status).toBe(200)
        expect([entry.request.httpVersion, entry.response.httpVersion]).toEqual([
          'http/2.0',
          'http/2.0',
        ])
        expect(entry.connection).toBe('0')
        expect([entry.timings.dns, entry.timings.connect, entry.timings.ssl]).toEqual([-1, -1, -1])
      }),
      { numRuns: RUNS }
    )
  })

  test('property: a navigation is a document fetch of an HTML shell titled as given', () => {
    fc.assert(
      fc.property(
        exchangeSpecArbitrary('page_1'),
        fc.stringMatching(/^[A-Za-z |]{1,40}$/),
        ({ pageref, startedAt, url, waitMillis, serverIPAddress }, title) => {
          const entry = ChromeHar.navigationEntryOf({
            pageref,
            startedAt,
            url,
            title,
            waitMillis,
            serverIPAddress,
          })
          expect(entry._resourceType).toBe('document')
          expect(entry.request.url).toBe(url)
          expect(entry.request.headers.map(([name]) => name)).toEqual(['accept'])
          expect(entry.response.content.mimeType).toBe('text/html; charset=utf-8')
          const { body } = entry.response.content
          expect(body?._tag === 'HarTextBody' ? body.text : null).toContain(
            `<title>${title}</title>`
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('its entries write under the DevTools creator, two-space indented', () => {
    const startedAt = DateTime.unsafeMake('2026-03-11T16:54:30.000Z')
    const archive = chromeHarOf(
      [
        chromePageOf({
          id: 'page_1',
          url: 'https://portal.example.org/',
          startedAt,
          onContentLoadMillis: 120,
          onLoadMillis: 340,
        }),
      ],
      [
        ChromeHar.entryOf({
          pageref: 'page_1',
          resourceType: 'document',
          startedAt,
          url: 'https://portal.example.org/',
          requestHeaders: [],
          mimeType: 'text/html; charset=utf-8',
          body: '<!doctype html>',
          waitMillis: 80,
          serverIPAddress: '203.0.113.7',
        }),
      ]
    )
    const text = Effect.runSync(chromeHarToJson(archive, { pretty: true }))
    expect(text.startsWith('{\n  "log": {\n')).toBe(true)
    expect(Effect.runSync(chromeHarFromJson(text)).log.creator).toEqual(CHROME_CREATOR)
  })
})
