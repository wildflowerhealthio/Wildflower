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
 * Keys whose string value is a URL, compared case-insensitively.
 *
 * @remarks
 * `url`, `http.url` and `url.full` are where Sentry's fetch/XHR spans and
 * breadcrumbs put the request URL; `from` and `to` are a navigation
 * breadcrumb's pages; `referer` is the request header Sentry reports with an
 * error.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  'url',
  'http.url',
  'url.full',
  'from',
  'to',
  'referer',
])

/** Keys that carry a URL's query string or fragment on their own; dropped outright. */
const DROPPED_KEYS: ReadonlySet<string> = new Set(['http.query', 'http.fragment'])

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
      if (DROPPED_KEYS.has(lowerCaseKey)) return [[key, undefined]]
      if (URL_KEYS.has(lowerCaseKey) && typeof value === 'string') {
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
 *   - each breadcrumb's and span's URL-valued data (`url`, `http.url`,
 *     `url.full`, `from`, `to`) is anonymized, and `http.query` /
 *     `http.fragment` cleared
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
