import { anonymizeHost, anonymizeUrl, anonymizeUrlsInText } from './anonymize-url.ts'
import { makeHostRedactor } from './redact-hosts.ts'

/**
 * Runs every URL a telemetry event carries through {@link anonymizeUrl}, and
 * every host it carries on its own through {@link anonymizeHost}, and
 * replaces the server hosts in its stack frames, before the event leaves the
 * browser. Typed structurally over the fields it reads, so
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
 * Sentry reports with an event; `code.filepath` is the script a long
 * animation frame span blames. The `.url` suffix covers the rest of the SDK's
 * URL attributes, such as the page-load span's `lcp.url`.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  'url',
  'url.full',
  'url.path',
  'from',
  'to',
  'referer',
  'code.filepath',
])

/**
 * Keys whose string value is a host, a hostname or an origin, compared
 * case-insensitively.
 *
 * @remarks
 * `server.address` is the request's host on Sentry's fetch/XHR spans and its
 * origin on Effect's HTTP client spans; `url.domain` is the hostname on the
 * SDK's other client spans; `http.host` and `net.peer.name` are the older
 * conventions' names for the same.
 */
const HOST_KEYS: ReadonlySet<string> = new Set([
  'server.address',
  'url.domain',
  'http.host',
  'net.peer.name',
])

/**
 * Keys whose string value is free text that can carry a URL, compared
 * case-insensitively: `browser.script.invoker` is the script URL on a long
 * animation frame span blaming a script, and a name such as
 * `IMG#avatar.onload` otherwise.
 */
const URL_IN_TEXT_KEYS: ReadonlySet<string> = new Set(['browser.script.invoker'])

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

/**
 * A stack frame of an error event: `filename` and `abs_path` are the URL of
 * the script it ran in, and `module` can be.
 */
interface ScrubbableStackFrame {
  readonly filename?: string
  readonly abs_path?: string
  readonly module?: string
}

/** An exception an error event reports, with the stack it was thrown from. */
interface ScrubbableException {
  readonly stacktrace?: { readonly frames?: readonly ScrubbableStackFrame[] }
}

/**
 * A debug image of an error event: the SDK lists each script a stack frame
 * ran in as one, with the frame's `abs_path` or `filename` as its `code_file`.
 */
interface ScrubbableDebugImage {
  readonly code_file?: string
}

/** The fields of a telemetry event {@link scrubEvent} rewrites. */
interface ScrubbableEvent {
  readonly transaction?: string
  readonly request?: ScrubbableRequest
  readonly breadcrumbs?: readonly ScrubbableBreadcrumb[]
  readonly spans?: readonly ScrubbableSpan[]
  readonly contexts?: { readonly trace?: ScrubbableSpan }
  readonly exception?: { readonly values?: readonly ScrubbableException[] }
  readonly debug_meta?: { readonly images?: readonly ScrubbableDebugImage[] }
}

/** Replaces the server hosts in a text with `{host}` (see {@link makeHostRedactor}). */
type HostRedactor = (text: string) => string

/** Whether the value under `lowerCaseKey` is a host. */
const isHostKey = (lowerCaseKey: string): boolean => HOST_KEYS.has(lowerCaseKey)

/** Whether the value under `lowerCaseKey` is free text that can carry a URL. */
const isUrlInTextKey = (lowerCaseKey: string): boolean => URL_IN_TEXT_KEYS.has(lowerCaseKey)

/**
 * `record` with the value under every URL, host or URL-in-text key anonymized
 * and the value under every dropped key cleared to `undefined`, which the SDK
 * leaves out of what it sends.
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
      if (isHostKey(lowerCaseKey) && typeof value === 'string') {
        return [[key, anonymizeHost(value)]]
      }
      if (isUrlInTextKey(lowerCaseKey) && typeof value === 'string') {
        return [[key, anonymizeUrlsInText(value)]]
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
 * `object` with the string under each of `keys` passed through `redactHosts`.
 */
const redactHostsUnder = <O extends object>(
  object: O,
  keys: readonly (keyof O)[],
  redactHosts: HostRedactor
): O => ({
  ...object,
  ...Object.fromEntries(
    keys.flatMap((key) => {
      const value = object[key]
      return typeof value === 'string' ? [[key, redactHosts(value)]] : []
    })
  ),
})

/**
 * `exception` with the server host in each stack frame's script URL replaced.
 *
 * @remarks
 * Only the host is replaced: the path and file name stay, so the frame still
 * reads as the bundle it ran in.
 */
const scrubException = <X extends ScrubbableException>(
  exception: X,
  redactHosts: HostRedactor
): X => {
  const frames = exception.stacktrace?.frames
  if (frames === undefined) return exception
  return {
    ...exception,
    stacktrace: {
      ...exception.stacktrace,
      frames: frames.map((frame) =>
        redactHostsUnder(frame, ['filename', 'abs_path', 'module'], redactHosts)
      ),
    },
  }
}

/**
 * `event` with every URL it carries anonymized.
 *
 * @typeParam E - The SDK's event type; every other field passes through
 * @returns A copy of `event` in which:
 *   - `request.url`, and a `Referer` request header, are anonymized, and
 *     `request.query_string` is cleared
 *   - each breadcrumb's and span's URL-valued data (`url`, `url.full`,
 *     `url.path`, `from`, `to`, `code.filepath`, and every key ending in
 *     `.url`) is anonymized, the URLs in `browser.script.invoker` too, its
 *     host-valued data (`server.address`, `url.domain`, `http.host`,
 *     `net.peer.name`) reduced to a kept host or `{host}`, and its query and
 *     fragment keys (`http.query`, `url.query`, …) and HTTP header attributes
 *     cleared
 *   - each span description, the trace context's, and the transaction name
 *     have the URLs in them anonymized
 *   - each stack frame's `filename`, `abs_path` and `module`, and each debug
 *     image's `code_file`, have every relay tunnel host
 *     (`*.relay.wildflowerhealth.io`) and every one of `hostsToRedact`
 *     replaced with `{host}`, the rest of the script URL kept as written
 *
 * @param hostsToRedact - The hosts the app is known to use (its own origin's,
 *   its servers'), as hosts or origins; see {@link makeHostRedactor}
 *
 * @remarks
 * Pure and field-by-field: every rewrite copies the object it changes, so the
 * SDK's own event is left as it was.
 *
 * Stack frames keep their source maps: the site's builds carry debug IDs
 * (`.github/actions/sentry-sourcemaps`), and the SDK lists each frame's script
 * as a debug image whose `code_file` is the frame's `abs_path` or `filename`.
 * Sentry pairs a frame with its image by that path and finds the map by the
 * image's debug ID, never by URL; frame and image are rewritten alike, so the
 * pairing holds. Running the URL through {@link anonymizeUrl} instead would
 * turn the bundle's file name into `{id}`.
 */
const scrubEvent = <E extends ScrubbableEvent>(
  event: E,
  hostsToRedact: Iterable<string> = []
): E => {
  const redactHosts = makeHostRedactor(hostsToRedact)
  return {
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
    ...(event.exception?.values === undefined
      ? {}
      : {
          exception: {
            ...event.exception,
            values: event.exception.values.map((exception) =>
              scrubException(exception, redactHosts)
            ),
          },
        }),
    ...(event.debug_meta?.images === undefined
      ? {}
      : {
          debug_meta: {
            ...event.debug_meta,
            images: event.debug_meta.images.map((image) =>
              redactHostsUnder(image, ['code_file'], redactHosts)
            ),
          },
        }),
  }
}

export type { ScrubbableEvent }
export { scrubEvent }
