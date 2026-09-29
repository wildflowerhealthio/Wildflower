import { DateTime } from 'effect'
import { utf8Bytes } from 'kitchen-sink'

/**
 * A HAR 1.2 archive in the shape a Chrome DevTools "Save all as HAR" export
 * writes: pages, `_initiator` / `_priority` / `_resourceType` extras, phase
 * timings, and every response body stored as text in `response.content.text`.
 *
 * @remarks
 * The wire types below are what this package writes, not a reader: the
 * archive is JSON text a HAR importer decodes (`http-archive`'s lenient
 * `HarFromJson` ignores the vendor extras). They follow the committed Chrome
 * capture `har-importer-core/src/fixtures/chrome-fhir-capture.har.json`.
 * Every source renderer builds its archive from {@link pageOf} and
 * {@link entryOf}, so the envelope is written in one place.
 */

/** A header or query parameter. */
interface NameValue {
  readonly name: string
  readonly value: string
}

/** HAR `pages[]`: one navigation. */
interface Page {
  readonly startedDateTime: string
  readonly id: string
  readonly title: string
  readonly pageTimings: { readonly onContentLoad: number; readonly onLoad: number }
}

/** What the browser fetched: a navigation (`document`) or a script's request (`xhr`). */
type ResourceType = 'document' | 'xhr'

/** HAR `entries[]`: one request and its response. */
interface Entry {
  readonly pageref: string
  readonly _initiator: { readonly type: 'other' | 'script' }
  readonly _priority: 'VeryHigh' | 'High'
  readonly _resourceType: ResourceType
  readonly startedDateTime: string
  readonly time: number
  readonly request: {
    readonly method: 'GET'
    readonly url: string
    readonly httpVersion: 'http/2.0'
    readonly headers: readonly NameValue[]
    readonly queryString: readonly NameValue[]
    readonly cookies: readonly []
    readonly headersSize: -1
    readonly bodySize: 0
  }
  readonly response: {
    readonly status: 200
    readonly statusText: ''
    readonly httpVersion: 'http/2.0'
    readonly headers: readonly NameValue[]
    readonly cookies: readonly []
    readonly content: { readonly size: number; readonly mimeType: string; readonly text: string }
    readonly redirectURL: ''
    readonly headersSize: -1
    readonly bodySize: number
  }
  readonly cache: Record<string, never>
  readonly timings: {
    readonly blocked: number
    readonly dns: -1
    readonly ssl: -1
    readonly connect: -1
    readonly send: number
    readonly wait: number
    readonly receive: number
  }
  readonly serverIPAddress: string
  readonly connection: string
}

/** A whole archive. */
interface ChromeHar {
  readonly log: {
    readonly version: '1.2'
    readonly creator: { readonly name: 'WebInspector'; readonly version: '537.36' }
    readonly pages: readonly Page[]
    readonly entries: readonly Entry[]
  }
}

/** The navigation {@link pageOf} writes. */
interface PageSpec {
  readonly id: string
  /** The page's URL, which DevTools uses as its title. */
  readonly url: string
  readonly startedAt: DateTime.Utc
  /** Milliseconds from `startedAt` to `DOMContentLoaded`. */
  readonly onContentLoadMillis: number
  /** Milliseconds from `startedAt` to `load`. */
  readonly onLoadMillis: number
}

/** The exchange {@link entryOf} writes: always a successful `GET`. */
interface ExchangeSpec {
  /** The {@link PageSpec.id} the exchange belongs to. */
  readonly pageref: string
  readonly resourceType: ResourceType
  readonly startedAt: DateTime.Utc
  readonly url: string
  readonly requestHeaders: readonly NameValue[]
  /** The response's `content-type`, also written as `content.mimeType`. */
  readonly mimeType: string
  /** The response body, stored verbatim as `content.text`. */
  readonly body: string
  /** Milliseconds the server took to answer (`timings.wait`). */
  readonly waitMillis: number
  readonly serverIPAddress: string
}

/** Fixed phase timings around `wait`, in milliseconds. */
const BLOCKED_MILLIS = 1.2
const SEND_MILLIS = 0.2
const RECEIVE_MILLIS = 3.1

/** A HAR page from a {@link PageSpec}. */
const pageOf = (spec: PageSpec): Page => ({
  startedDateTime: DateTime.formatIso(spec.startedAt),
  id: spec.id,
  title: spec.url,
  pageTimings: { onContentLoad: spec.onContentLoadMillis, onLoad: spec.onLoadMillis },
})

/** The query parameters of `url`, in order, as HAR lists them. */
const queryStringOf = (url: string): readonly NameValue[] =>
  [...new URL(url).searchParams].map(([name, value]) => ({ name, value }))

/**
 * A HAR entry from an {@link ExchangeSpec}.
 *
 * @remarks
 * `content.size` and `bodySize` are the body's UTF-8 byte length (the export
 * records the transfer uncompressed), and `time` is the sum of the measured
 * phases, as HAR defines it.
 */
const entryOf = (spec: ExchangeSpec): Entry => {
  const bodySize = utf8Bytes(spec.body).length
  return {
    pageref: spec.pageref,
    _initiator: { type: spec.resourceType === 'document' ? 'other' : 'script' },
    _priority: spec.resourceType === 'document' ? 'VeryHigh' : 'High',
    _resourceType: spec.resourceType,
    startedDateTime: DateTime.formatIso(spec.startedAt),
    time: BLOCKED_MILLIS + SEND_MILLIS + spec.waitMillis + RECEIVE_MILLIS,
    request: {
      method: 'GET',
      url: spec.url,
      httpVersion: 'http/2.0',
      headers: spec.requestHeaders,
      queryString: queryStringOf(spec.url),
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: '',
      httpVersion: 'http/2.0',
      headers: [{ name: 'content-type', value: spec.mimeType }],
      cookies: [],
      content: { size: bodySize, mimeType: spec.mimeType, text: spec.body },
      redirectURL: '',
      headersSize: -1,
      bodySize,
    },
    cache: {},
    timings: {
      blocked: BLOCKED_MILLIS,
      dns: -1,
      ssl: -1,
      connect: -1,
      send: SEND_MILLIS,
      wait: spec.waitMillis,
      receive: RECEIVE_MILLIS,
    },
    serverIPAddress: spec.serverIPAddress,
    connection: '0',
  }
}

/** An archive of `pages` and `entries`, as a DevTools export names its creator. */
const archiveOf = (pages: readonly Page[], entries: readonly Entry[]): ChromeHar => ({
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    pages,
    entries,
  },
})

/** The archive as `.har` file text: two-space-indented JSON, byte-identical for equal archives. */
const toJson = (archive: ChromeHar): string => `${JSON.stringify(archive, null, 2)}\n`

/** The headers a browser sends on a page navigation. */
const DOCUMENT_REQUEST_HEADERS: readonly NameValue[] = [
  { name: 'accept', value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
]

/** A single-page app's shell document: the body a navigation records, which no importer claims. */
const appShellOf = (title: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root"></div></body></html>`

export { appShellOf, archiveOf, DOCUMENT_REQUEST_HEADERS, entryOf, pageOf, toJson }
export type { ChromeHar, Entry, ExchangeSpec, NameValue, Page, PageSpec, ResourceType }
