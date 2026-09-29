import type { DateTime, Effect, ParseResult } from 'effect'
import {
  type ChromeHar,
  type ChromeHarEntry,
  chromeHarToJson,
  type HarPage,
  NOT_MEASURED,
  queryStringOf,
} from 'http-archive'
import { utf8Bytes } from 'kitchen-sink'

/**
 * A synthetic browser session as a Chrome DevTools "Save all as HAR" export
 * records it: `http-archive`'s {@link ChromeHar} values, filled with the
 * defaults a generator does not choose.
 *
 * @remarks
 * The archive format, its DevTools extras and its JSON text are
 * `http-archive`'s; this module holds only what makes a generated capture
 * look like a recorded one — the `WebInspector` creator, fixed phase timings
 * around a chosen `wait`, and the `document` / `xhr` split that decides each
 * entry's `_initiator`, `_priority` and `_resourceType`. Every HAR generator
 * builds its archive from {@link pageOf} and {@link entryOf}, so those
 * defaults are written in one place.
 */

/** What the browser fetched: a navigation (`document`) or a script's request (`xhr`). */
type ResourceType = 'document' | 'xhr'

/** The fetch priority DevTools reports for a {@link ResourceType}. */
type Priority = 'VeryHigh' | 'High'

/** What DevTools says caused a {@link ResourceType}'s request. */
type InitiatorType = 'other' | 'script'

/**
 * A {@link ChromeHarEntry} as {@link entryOf} writes it, with the DevTools
 * extras narrowed to the values a synthetic capture uses.
 */
type Entry = ChromeHarEntry & {
  readonly _initiator: { readonly type: InitiatorType }
  readonly _priority: Priority
  readonly _resourceType: ResourceType
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

/** The `_initiator` type and `_priority` DevTools records for each resource type. */
const DEVTOOLS_EXTRAS: Readonly<
  Record<ResourceType, { readonly initiator: InitiatorType; readonly priority: Priority }>
> = {
  document: { initiator: 'other', priority: 'VeryHigh' },
  xhr: { initiator: 'script', priority: 'High' },
}

/** A HAR page from a {@link PageSpec}. */
const pageOf = (spec: PageSpec): HarPage => ({
  startedDateTime: spec.startedAt,
  id: spec.id,
  title: spec.url,
  pageTimings: { onContentLoad: spec.onContentLoadMillis, onLoad: spec.onLoadMillis },
})

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
  const extras = DEVTOOLS_EXTRAS[spec.resourceType]
  return {
    pageref: spec.pageref,
    _initiator: { type: extras.initiator },
    _priority: extras.priority,
    _resourceType: spec.resourceType,
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

/** An archive of `pages` and `entries`, as a DevTools export names its creator. */
const archiveOf = (pages: readonly HarPage[], entries: readonly Entry[]): ChromeHar => ({
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    pages,
    entries,
  },
})

/**
 * The archive as `.har` file text, two-space indented as DevTools writes it,
 * the extras included.
 */
const toJson = (archive: ChromeHar): Effect.Effect<string, ParseResult.ParseError> =>
  chromeHarToJson(archive, { pretty: true })

export { archiveOf, entryOf, pageOf, toJson }
export type { Entry, ExchangeSpec, InitiatorType, PageSpec, Priority, ResourceType }
