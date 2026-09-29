// oxlint-disable no-underscore-dangle -- `_initiator`, `_priority` and `_resourceType` are the exact keys a DevTools export writes; these tests read them back.
import { DateTime, Effect } from 'effect'
import * as fc from 'fast-check'
import { chromeHarFromJson } from 'http-archive'
import { utf8Bytes } from 'kitchen-sink'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as HarCapture from './har-capture.ts'
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

const pageSpecArbitrary = (id: string): fc.Arbitrary<HarCapture.PageSpec> =>
  fc.record({
    id: fc.constant(id),
    url: urlArbitrary,
    startedAt: asOfArbitrary,
    onContentLoadMillis: fc.integer({ min: 1, max: 5000 }),
    onLoadMillis: fc.integer({ min: 1, max: 5000 }),
  })

const exchangeSpecArbitrary = (pageref: string): fc.Arbitrary<HarCapture.ExchangeSpec> =>
  fc.record({
    pageref: fc.constant(pageref),
    resourceType: fc.constantFrom<HarCapture.ResourceType>('document', 'xhr'),
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

describe('HarCapture', () => {
  test('property: an archive writes to text that `http-archive` reads back unchanged', () => {
    fc.assert(
      fc.property(captureArbitrary, ({ pages, exchanges }) => {
        const archive = HarCapture.archiveOf(
          pages.map(HarCapture.pageOf),
          exchanges.map(HarCapture.entryOf)
        )
        const text = Effect.runSync(HarCapture.toJson(archive))
        expect(Effect.runSync(chromeHarFromJson(text))).toEqual(archive)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: a navigation is initiated by the browser, an XHR by a script', () => {
    fc.assert(
      fc.property(exchangeSpecArbitrary('page_1'), (spec) => {
        const entry = HarCapture.entryOf(spec)
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
        const entry = HarCapture.entryOf(spec)
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
        expect(HarCapture.entryOf(spec).request.queryString).toEqual(
          [...new URL(spec.url).searchParams].map(([name, value]) => ({ name, value }))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('writes the archive as a DevTools export does: WebInspector, two-space indented', () => {
    const startedAt = DateTime.unsafeMake('2026-03-11T16:54:30.000Z')
    const archive = HarCapture.archiveOf(
      [
        HarCapture.pageOf({
          id: 'page_1',
          url: 'https://portal.example.org/',
          startedAt,
          onContentLoadMillis: 120,
          onLoadMillis: 340,
        }),
      ],
      []
    )
    const text = Effect.runSync(HarCapture.toJson(archive))
    expect(text.startsWith('{\n  "log": {\n')).toBe(true)
    expect(archive.log.creator).toEqual({ name: 'WebInspector', version: '537.36' })
    expect(archive.log.pages?.[0]?.title).toBe('https://portal.example.org/')
  })
})
