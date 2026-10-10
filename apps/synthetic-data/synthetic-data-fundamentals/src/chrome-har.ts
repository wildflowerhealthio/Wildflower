import {
  type ChromeHarEntry,
  type ChromeHarExtras,
  type ChromeResourceType,
  chromeExtrasOf,
  NOT_MEASURED,
  queryStringOf,
} from '@wildflowerhealthio/http-archive'
import { utf8Bytes } from '@wildflowerhealthio/kitchen-sink'
import type { DateTime } from 'effect'

/**
 * The synthetic defaults a generated Chrome DevTools capture is written with;
 * the format and DevTools vocabulary are `http-archive`'s.
 *
 * @remarks
 * `http-archive` owns the archive ({@link ChromeHarEntry}, `chromeHarToJson`),
 * what DevTools writes (`CHROME_CREATOR`, `chromeExtrasOf`), and the page and
 * archive builders (`chromePageOf`, `chromeHarOf`). This module holds only
 * what a generator does not choose and a recording would have measured: every
 * exchange is a `200` `GET` over a reused HTTP/2 connection, with fixed phase
 * timings around a chosen `wait` and its body stored as text. Every HAR
 * generator builds its entries with {@link entryOf}, and its page navigations
 * with {@link navigationEntryOf}, so those defaults are written in one place.
 */

/**
 * A {@link ChromeHarEntry} as {@link entryOf} writes it, with the DevTools
 * extras narrowed to the values a producer writes.
 */
type Entry = ChromeHarEntry & ChromeHarExtras

/** The exchange {@link entryOf} writes: always a successful `GET`. */
interface ExchangeSpec {
  /** The id of the page the exchange belongs to (`chromePageOf`'s `id`). */
  readonly pageref: string
  /** What the browser fetched, which decides the entry's DevTools extras. */
  readonly resourceType: ChromeResourceType
  readonly startedAt: DateTime.Utc
  readonly url: string
  readonly requestHeaders: ChromeHarEntry['request']['headers']
  /** The response's `content-type`, also written as `content.mimeType`. */
  readonly mimeType: string
  /** The response body, stored verbatim as text. */
  readonly body: string
  /** Milliseconds the server took to answer (`timings.wait`). */
  readonly waitMillis: number
  readonly serverIPAddress: string
}

/** Fixed phase timings around `wait`, in milliseconds. */
const BLOCKED_MILLIS = 1.2
const SEND_MILLIS = 0.2
const RECEIVE_MILLIS = 3.1

/**
 * A HAR entry from an {@link ExchangeSpec}.
 *
 * @remarks
 * `content.size` and `bodySize` are the body's UTF-8 byte length (the export
 * records the transfer uncompressed), and `time` is the sum of the measured
 * phases, as HAR defines it. The `_initiator`, `_priority` and
 * `_resourceType` are `http-archive`'s `chromeExtrasOf` for the spec's
 * resource type.
 */
const entryOf = (spec: ExchangeSpec): Entry => {
  const bodySize = utf8Bytes(spec.body).length
  return {
    pageref: spec.pageref,
    ...chromeExtrasOf(spec.resourceType),
    startedDateTime: spec.startedAt,
    time: BLOCKED_MILLIS + SEND_MILLIS + spec.waitMillis + RECEIVE_MILLIS,
    request: {
      method: 'GET',
      url: spec.url,
      httpVersion: 'http/2.0',
      headers: spec.requestHeaders,
      queryString: queryStringOf(spec.url),
      cookies: [],
      headersSize: NOT_MEASURED,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: '',
      httpVersion: 'http/2.0',
      headers: [['content-type', spec.mimeType]],
      cookies: [],
      content: {
        size: bodySize,
        mimeType: spec.mimeType,
        body: { _tag: 'HarTextBody', text: spec.body },
      },
      redirectURL: '',
      headersSize: NOT_MEASURED,
      bodySize,
    },
    cache: {},
    timings: {
      blocked: BLOCKED_MILLIS,
      // A reused HTTP/2 connection: no DNS lookup, connect or TLS handshake.
      dns: NOT_MEASURED,
      ssl: NOT_MEASURED,
      connect: NOT_MEASURED,
      send: SEND_MILLIS,
      wait: spec.waitMillis,
      receive: RECEIVE_MILLIS,
    },
    serverIPAddress: spec.serverIPAddress,
    connection: '0',
  }
}

/** A top-level navigation {@link navigationEntryOf} writes: a page's shell document. */
interface NavigationSpec extends Omit<
  ExchangeSpec,
  'resourceType' | 'requestHeaders' | 'mimeType' | 'body'
> {
  /** The document's `<title>`. */
  readonly title: string
}

/** The `accept` header a browser sends on a top-level navigation. */
const NAVIGATION_REQUEST_HEADERS: ExchangeSpec['requestHeaders'] = [
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
]

const HTML_MIME = 'text/html; charset=utf-8'

/**
 * A HAR entry for a page navigation, from a {@link NavigationSpec}: a
 * `document` fetch whose body is a single-page app's empty shell.
 *
 * @remarks
 * A generated portal session opens its pages with these. The shell carries
 * nothing a response kind claims, as a real export's navigations don't, so an
 * import notes each as unmatched and reads only the XHRs.
 */
const navigationEntryOf = ({ title, ...spec }: NavigationSpec): Entry =>
  entryOf({
    ...spec,
    resourceType: 'document',
    requestHeaders: NAVIGATION_REQUEST_HEADERS,
    mimeType: HTML_MIME,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root"></div></body></html>`,
  })

export { entryOf, navigationEntryOf }
export type { Entry, ExchangeSpec, NavigationSpec }
