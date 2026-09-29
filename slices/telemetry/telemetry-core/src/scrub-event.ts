import { anonymizeUrl, anonymizeUrlsInText } from './anonymize-url.ts'

/**
 * Runs every URL a telemetry event carries through {@link anonymizeUrl} before
 * the event leaves the browser. Typed structurally over the fields it reads, so
 * this package names no Sentry type: `telemetry-web` hands it Sentry's error
 * and transaction events.
 */

/** A key–value bag an event carries URLs in: span attributes, breadcrumb data, request headers. */
type UrlBearingRecord = Readonly<Record<string, unknown>>

/**
 * Keys whose string value is a URL, compared case-insensitively; so is every
 * key ending in `.url` (see {@link isUrlKey}).
 *
 * @remarks
 * `url`, `http.url` and `url.full` are where Sentry's fetch/XHR spans and
 * breadcrumbs, and Effect's HTTP client spans, put the request URL; `url.path`
 * is its path on browser page-load and Effect HTTP client spans; `from` and
 * `to` are a navigation breadcrumb's pages; `referer` is the request header
 * Sentry reports with an event. The `.url` suffix covers the rest of the
 * SDK's URL attributes, such as the page-load span's `lcp.url`.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  'url',
  'url.full',
  'url.path',
  'from',
  'to',
  'referer',
])

/** Keys that carry a URL's query string or fragment on their own; dropped outright. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
  'http.query',
  'http.fragment',
  'url.query',
  'url.fragment',
])

/**
 * Prefixes of the span attributes that carry an HTTP header each (Effect's
 * HTTP client records every request and response header, and a FHIR server's
 * `Location` and `Content-Location` name the resource by id); dropped
 * outright, like the headers the SDK itself is told not to collect.
 */
const DROPPED_KEY_PREFIXES: readonly string[] = ['http.request.header.', 'http.response.header.']

/** Whether the value under `lowerCaseKey` is a URL. */
const isUrlKey = (lowerCaseKey: string): boolean =>
  URL_KEYS.has(lowerCaseKey) || lowerCaseKey.endsWith('.url')

/** Whether the value under `lowerCaseKey` is dropped rather than anonymized. */
const isDroppedKey = (lowerCaseKey: string): boolean =>
  DROPPED_KEYS.has(lowerCaseKey) ||
  DROPPED_KEY_PREFIXES.some((prefix) => lowerCaseKey.startsWith(prefix))

/** The request an error or transaction event reports. */
interface ScrubbableRequest {
  readonly url?: string
  readonly query_string?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/** A breadcrumb: what happened before the event, fetches and navigations among it. */
interface ScrubbableBreadcrumb {
  readonly data?: UrlBearingRecord
}

/** A span in a transaction event, or the transaction's own trace context. */
interface ScrubbableSpan {
  readonly description?: string
  readonly data?: UrlBearingRecord
}

/** The fields of a telemetry event {@link scrubEvent} rewrites. */
interface ScrubbableEvent {
  readonly transaction?: string
  readonly request?: ScrubbableRequest
  readonly breadcrumbs?: readonly ScrubbableBreadcrumb[]
  readonly spans?: readonly ScrubbableSpan[]
  readonly contexts?: { readonly trace?: ScrubbableSpan }
}

/**
 * `record` with the value under every URL key anonymized and the value under
 * every dropped key cleared to `undefined`, which the SDK leaves out of what it
 * sends.
 */
const scrubUrlBearingRecord = <R extends UrlBearingRecord>(record: R): R => ({
  ...record,
  ...Object.fromEntries(
    Object.entries(record).flatMap(([key, value]): (readonly [string, unknown])[] => {
      const lowerCaseKey = key.toLowerCase()
      if (isDroppedKey(lowerCaseKey)) return [[key, undefined]]
      if (isUrlKey(lowerCaseKey) && typeof value === 'string') {
        return [[key, anonymizeUrl(value)]]
      }
      return []
    })
  ),
})

const scrubRequest = <R extends ScrubbableRequest>(request: R): R => ({
  ...request,
  ...(request.url === undefined ? {} : { url: anonymizeUrl(request.url) }),
  ...(request.query_string === undefined ? {} : { query_string: undefined }),
  ...(request.headers === undefined ? {} : { headers: scrubUrlBearingRecord(request.headers) }),
})

const scrubBreadcrumb = <B extends ScrubbableBreadcrumb>(breadcrumb: B): B => ({
  ...breadcrumb,
  ...(breadcrumb.data === undefined ? {} : { data: scrubUrlBearingRecord(breadcrumb.data) }),
})

const scrubSpan = <S extends ScrubbableSpan>(span: S): S => ({
  ...span,
  ...(span.description === undefined ? {} : { description: anonymizeUrlsInText(span.description) }),
  ...(span.data === undefined ? {} : { data: scrubUrlBearingRecord(span.data) }),
})

/**
 * `event` with every URL it carries anonymized.
 *
 * @typeParam E - The SDK's event type; every other field passes through
 * @returns A copy of `event` in which:
 *   - `request.url`, and a `Referer` request header, are anonymized, and
 *     `request.query_string` is cleared
 *   - each breadcrumb's and span's URL-valued data (`url`, `url.full`,
 *     `url.path`, `from`, `to`, and every key ending in `.url`) is
 *     anonymized, and its query and fragment keys (`http.query`,
 *     `url.query`, …) and HTTP header attributes cleared
 *   - each span description, the trace context's, and the transaction name
 *     have the URLs in them anonymized
 *
 * @remarks
 * Pure and field-by-field: every rewrite copies the object it changes, so the
 * SDK's own event is left as it was.
 */
const scrubEvent = <E extends ScrubbableEvent>(event: E): E => ({
  ...event,
  ...(event.transaction === undefined
    ? {}
    : { transaction: anonymizeUrlsInText(event.transaction) }),
  ...(event.request === undefined ? {} : { request: scrubRequest(event.request) }),
  ...(event.breadcrumbs === undefined
    ? {}
    : { breadcrumbs: event.breadcrumbs.map(scrubBreadcrumb) }),
  ...(event.spans === undefined ? {} : { spans: event.spans.map(scrubSpan) }),
  ...(event.contexts?.trace === undefined
    ? {}
    : { contexts: { ...event.contexts, trace: scrubSpan(event.contexts.trace) } }),
})

export type { ScrubbableEvent }
export { scrubEvent }
