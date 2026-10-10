import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
// oxlint-disable no-underscore-dangle -- `_initiator`, `_priority` and `_resourceType` are the exact keys a DevTools export writes; these tests read them back.
import { DateTime, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  CHROME_CREATOR,
  type ChromeHar,
  type ChromeHarEntry,
  type ChromePageSpec,
  type ChromeResourceType,
  chromeExtrasOf,
  chromeHarFromJson,
  chromeHarOf,
  chromeHarToJson,
  chromePageOf,
} from './chrome-har.ts'
import chromeExport from './fixtures/chrome-devtools.har.json' with { type: 'json' }
import { Har, HarFromJson } from './har.ts'

const exportJson = JSON.stringify(chromeExport)

const readChrome = (json: string): ChromeHar => Effect.runSync(chromeHarFromJson(json))

const readBase = (json: string): Har => Effect.runSync(Schema.decodeUnknown(HarFromJson)(json))

const writeChrome = (har: ChromeHar): string => Effect.runSync(chromeHarToJson(har))

/** A written file's entries as the plain JSON objects they are, whatever keys they hold. */
const readWrittenEntries = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      log: Schema.Struct({
        entries: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    })
  )
)

/** The `_`-prefixed keys an object carries, which is what the Chrome schemas add. */
const vendorKeysOf = (value: object): readonly string[] =>
  Object.keys(value).filter((key) => key.startsWith('_'))

/** One DevTools entry, built the way a producer of a Chrome archive builds it. */
const chromeEntry = (overrides: Partial<ChromeHarEntry> = {}): ChromeHarEntry => ({
  pageref: 'page_1',
  startedDateTime: DateTime.unsafeMake('2026-05-04T15:22:31.204Z'),
  time: 12,
  request: {
    method: 'GET',
    url: 'https://portal.example.org/api/v2/patients?q=ada',
    httpVersion: 'http/2.0',
    cookies: [],
    headers: [['accept', 'application/json']],
    queryString: [{ name: 'q', value: 'ada' }],
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status: 200,
    statusText: '',
    httpVersion: 'http/2.0',
    cookies: [],
    headers: [['content-type', 'application/json']],
    content: { size: 2, mimeType: 'application/json', body: { _tag: 'HarTextBody', text: '{}' } },
    redirectURL: '',
    headersSize: -1,
    bodySize: 2,
  },
  cache: {},
  timings: { blocked: 1, dns: -1, connect: -1, ssl: -1, send: 1, wait: 8, receive: 2 },
  serverIPAddress: '203.0.113.7',
  connection: '443',
  _initiator: { type: 'script' },
  _priority: 'High',
  _resourceType: 'xhr',
  ...overrides,
})

const chromeArchive = (entries: readonly ChromeHarEntry[]): ChromeHar => ({
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    pages: [
      {
        startedDateTime: DateTime.unsafeMake('2026-05-04T15:22:31.104Z'),
        id: 'page_1',
        title: 'https://portal.example.org/records',
        pageTimings: { onContentLoad: 412.5, onLoad: 903.1 },
      },
    ],
    entries,
  },
})

describe('ChromeHar', () => {
  test('a DevTools export decodes with its entry extras', () => {
    const [search, pixel, records] = readChrome(exportJson).log.entries
    expect(search?._initiator).toEqual({ type: 'script', stack: { callFrames: [] } })
    expect(search?._priority).toBe('High')
    expect(search?._resourceType).toBe('fetch')
    expect(pixel?._priority).toBeUndefined()
    expect(pixel?._resourceType).toBe('image')
    expect(records?._initiator).toEqual({ type: 'other' })
  })

  test('a built archive round-trips through its file text, pages and extras included', () => {
    const archive = chromeArchive([
      chromeEntry(),
      chromeEntry({ _initiator: { type: 'parser', url: 'https://portal.example.org/' } }),
    ])
    expect(readChrome(writeChrome(archive))).toEqual(archive)
  })

  test('a DevTools export re-encodes to the same archive it decoded to', () => {
    const decoded = readChrome(exportJson)
    expect(readChrome(writeChrome(decoded))).toEqual(decoded)
  })

  test('the written file carries the extras as DevTools names them', () => {
    const written = readWrittenEntries(writeChrome(chromeArchive([chromeEntry()])))
    const [entry] = written.log.entries
    expect(entry?.['_initiator']).toEqual({ type: 'script' })
    expect(entry?.['_priority']).toBe('High')
    expect(entry?.['_resourceType']).toBe('xhr')
    expect(entry?.['pageref']).toBe('page_1')
  })

  test('encoding through the base Har drops the extras — the reason ChromeHar exists', () => {
    const archive = chromeArchive([chromeEntry()])
    const [entry] = Schema.encodeSync(Har)(archive).log.entries
    expect(vendorKeysOf(entry ?? {})).toEqual([])
    expect(entry?.pageref).toBe('page_1')
  })

  test('pretty writes two-space-indented JSON of the same archive', () => {
    const archive = chromeArchive([chromeEntry()])
    const pretty = Effect.runSync(chromeHarToJson(archive, { pretty: true }))
    expect(pretty).toBe(JSON.stringify(JSON.parse(writeChrome(archive)), null, 2))
    expect(writeChrome(archive)).not.toContain('\n')
  })
})

const RESOURCE_TYPES: readonly ChromeResourceType[] = ['document', 'xhr', 'fetch']

const PAGE_SPEC: ChromePageSpec = {
  id: 'page_1',
  url: 'https://portal.example.org/records',
  startedAt: DateTime.unsafeMake('2026-05-04T15:22:31.104Z'),
  onContentLoadMillis: 412.5,
  onLoadMillis: 903.1,
}

describe('the ChromeHar producer vocabulary', () => {
  test('chromeExtrasOf gives every resource type its initiator and priority', () => {
    expect(RESOURCE_TYPES.map(chromeExtrasOf)).toEqual([
      { _initiator: { type: 'other' }, _priority: 'VeryHigh', _resourceType: 'document' },
      { _initiator: { type: 'script' }, _priority: 'High', _resourceType: 'xhr' },
      { _initiator: { type: 'script' }, _priority: 'High', _resourceType: 'fetch' },
    ])
  })

  test('chromePageOf titles a page with its URL, as DevTools does', () => {
    expect(chromePageOf(PAGE_SPEC)).toEqual({
      startedDateTime: PAGE_SPEC.startedAt,
      id: 'page_1',
      title: 'https://portal.example.org/records',
      pageTimings: { onContentLoad: 412.5, onLoad: 903.1 },
    })
  })

  test('property: an archive built with it round-trips, creator and extras included', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...RESOURCE_TYPES), { maxLength: 4 }),
        fc.boolean(),
        (resourceTypes, pretty) => {
          const archive = chromeHarOf(
            [chromePageOf(PAGE_SPEC)],
            resourceTypes.map((resourceType) => chromeEntry(chromeExtrasOf(resourceType)))
          )
          const read = Effect.runSync(
            chromeHarFromJson(Effect.runSync(chromeHarToJson(archive, { pretty })))
          )
          expect(read).toEqual(archive)
          expect(read.log.creator).toEqual(CHROME_CREATOR)
          expect(read.log.version).toBe('1.2')
          expect(read.log.entries.map((entry) => entry._resourceType)).toEqual(resourceTypes)
          expect(read.log.entries.map((entry) => entry._initiator?.type)).toEqual(
            resourceTypes.map((resourceType) => chromeExtrasOf(resourceType)._initiator.type)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('the base Har, reading a DevTools export', () => {
  const archive = readBase(exportJson)

  test('reads the HAR 1.2 page and entry fields the export states', () => {
    expect(archive.log.pages).toEqual([
      {
        startedDateTime: DateTime.unsafeMake('2026-05-04T15:22:31.104Z'),
        id: 'page_1',
        title: 'https://portal.example.org/records',
        pageTimings: { onContentLoad: 412.5, onLoad: 903.1 },
      },
    ])
    const [search, pixel] = archive.log.entries
    expect(search?.pageref).toBe('page_1')
    expect(search?.serverIPAddress).toBe('203.0.113.7')
    expect(search?.connection).toBe('443')
    expect(search?.timings).toEqual({
      blocked: 1.2,
      dns: -1,
      connect: -1,
      send: 0.3,
      wait: 110.9,
      receive: 6.02,
      ssl: -1,
    })
    // Spec-optional phases the export left out stay absent rather than -1.
    expect(pixel?.timings).toEqual({ blocked: 0.4, send: 0.1, wait: 20.4, receive: 1.6 })
  })

  test('drops only the Chrome extras: the rest equals the ChromeHar read', () => {
    const chrome = readChrome(exportJson)
    const withoutExtras = chrome.log.entries.map(
      ({ _initiator, _priority, _resourceType, ...entry }) => entry
    )
    expect(archive.log.entries).toEqual(withoutExtras)
    expect(archive.log.entries.flatMap(vendorKeysOf)).toEqual([])
    expect(archive.log.pages).toEqual(chrome.log.pages)
  })

  test('an archive with no pages, pageref or connection phases still reads', () => {
    const { log } = readBase(
      '{"log":{"entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"https://portal.example.org/"},"response":{"status":200,"content":{}}}]}}'
    )
    expect(log.pages).toBeUndefined()
    expect(log.entries[0]?.pageref).toBeUndefined()
    expect(log.entries[0]?.timings).toEqual({ send: -1, wait: -1, receive: -1 })
  })

  test('a page with only an id and start reads with an empty title and no timings', () => {
    const { log } = readBase(
      '{"log":{"pages":[{"startedDateTime":"2026-05-04T15:22:31.104Z","id":"page_1"}],"entries":[]}}'
    )
    expect(log.pages).toEqual([
      {
        startedDateTime: DateTime.unsafeMake('2026-05-04T15:22:31.104Z'),
        id: 'page_1',
        title: '',
        pageTimings: {},
      },
    ])
  })
})
