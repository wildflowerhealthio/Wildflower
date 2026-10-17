import { anonymizeHost, anonymizeUrl, anonymizeUrlsInText } from './anonymize-url.ts'
import { type HostRedactor, makeHostRedactor } from './redact-hosts.ts'

/**
 * Runs every URL a telemetry event carries through {@link anonymizeUrl}, and
 * every host it carries on its own through {@link anonymizeHost}, and
 * replaces the server hosts it names anywhere else, before the event leaves
 * the browser. Typed structurally over the fields it reads, so
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
 * Sentry reports with an event. The `.url` suffix covers the rest of the SDK's
 * URL attributes, such as the page-load span's `lcp.url`.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  'url',
  'url.full',
  'url.path',
  'from',
  'to',
  'referer',
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
 * Keys whose string value names a script, compared case-insensitively:
 * `code.filepath` is the script a long animation frame span blames, and
 * `browser.script.invoker` is its URL too when the span blames a script,
 * and a name such as `IMG#avatar.onload` otherwise.
 */
const SCRIPT_KEYS: ReadonlySet<string> = new Set(['code.filepath', 'browser.script.invoker'])

/**
 * Keys whose string value is free text, compared case-insensitively:
 * `transaction` is the route name a standalone span, such as INP's, carries
 * as an attribute, which can be a URL's path.
 */
const TEXT_KEYS: ReadonlySet<string> = new Set(['transaction'])

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
  readonly message?: string
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

/**
 * An exception an error event reports: its message, and the stack it was
 * thrown from.
 */
interface ScrubbableException {
  readonly value?: string
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
  readonly message?: string
  readonly logentry?: { readonly message?: string; readonly params?: readonly unknown[] }
  readonly transaction?: string
  readonly request?: ScrubbableRequest
  readonly breadcrumbs?: readonly ScrubbableBreadcrumb[]
  readonly spans?: readonly ScrubbableSpan[]
  readonly contexts?: Readonly<Record<string, unknown>> & { readonly trace?: ScrubbableSpan }
  readonly exception?: { readonly values?: readonly ScrubbableException[] }
  readonly debug_meta?: { readonly images?: readonly ScrubbableDebugImage[] }
  readonly tags?: Readonly<Record<string, unknown>>
  readonly extra?: Readonly<Record<string, unknown>>
}

/** Whether the value under `lowerCaseKey` is a host. */
const isHostKey = (lowerCaseKey: string): boolean => HOST_KEYS.has(lowerCaseKey)

/** Whether the value under `lowerCaseKey` names a script. */
const isScriptKey = (lowerCaseKey: string): boolean => SCRIPT_KEYS.has(lowerCaseKey)

/** Whether the value under `lowerCaseKey` is free text. */
const isTextKey = (lowerCaseKey: string): boolean => TEXT_KEYS.has(lowerCaseKey)

/**
 * `value` with `redactHosts` applied to every string in it, at any depth of
 * arrays and plain objects, object keys included; any other value as it was.
 *
 * @remarks
 * For the values whose shape the event does not fix: breadcrumb and span data
 * under keys that are not URLs or hosts (a console breadcrumb's `arguments`,
 * which can hold a record keyed by server domain), tags, `extra`, and
 * contexts (a React component stack names each component's script by URL).
 * The SDK has already normalized them to JSON.
 */
const redactHostsInValue = (value: unknown, redactHosts: HostRedactor): unknown => {
  if (typeof value === 'string') return redactHosts(value)
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactHostsInValue(item, redactHosts))
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return redactHostsInRecord(value, redactHosts)
  }
  return value
}

/**
 * `record` with {@link redactHostsInValue} applied to each of its keys and
 * values. Two keys that redact alike keep the later one's value.
 */
const redactHostsInRecord = (
  record: object,
  redactHosts: HostRedactor
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]: readonly [string, unknown]) => [
      redactHosts(key),
      redactHostsInValue(value, redactHosts),
    ])
  )

/**
 * `text` with the URLs in it anonymized (see `anonymizeUrlsInText`), then the
 * server hosts left in it replaced: for the free text an event carries, such
 * as an exception's message.
 */
const scrubText = (text: string, redactHosts: HostRedactor): string =>
  redactHosts(anonymizeUrlsInText(text))

/**
 * `script` (a script's URL, or the name of what ran it) reported as a stack
 * frame reports its script: an `http(s)` URL keeps its path and file name, so
 * the span still says which bundle is slow, and loses its query string,
 * fragment and credentials, and the server hosts in it are replaced. A URL of
 * any other scheme (`blob:`, `data:`) is anonymized (see
 * {@link anonymizeUrl}); a name that is not a URL keeps everything but its
 * server hosts.
 */
const scrubScript = (script: string, redactHosts: HostRedactor): string => {
  const url = URL.parse(script)
  if (url === null) return redactHosts(script)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return anonymizeUrl(script)
  return redactHosts(`${url.protocol}//${url.host}${url.pathname}`)
}

/**
 * `record` with the value under every URL or host key anonymized, the script
 * under every script key scrubbed (see `scrubScript`), the text under every
 * text key scrubbed (see `scrubText`), the value under every dropped key
 * cleared to `undefined`, which the SDK leaves out of what it sends, and the
 * server hosts in every other key and value replaced.
 */
const scrubUrlBearingRecord = (
  record: UrlBearingRecord,
  redactHosts: HostRedactor
): UrlBearingRecord =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]): readonly [string, unknown] => {
      const lowerCaseKey = key.toLowerCase()
      if (isDroppedKey(lowerCaseKey)) return [key, undefined]
      if (isUrlKey(lowerCaseKey) && typeof value === 'string') {
        return [key, anonymizeUrl(value)]
      }
      if (isHostKey(lowerCaseKey) && typeof value === 'string') {
        return [key, anonymizeHost(value)]
      }
      if (isScriptKey(lowerCaseKey) && typeof value === 'string') {
        return [key, scrubScript(value, redactHosts)]
      }
      if (isTextKey(lowerCaseKey) && typeof value === 'string') {
        return [key, scrubText(value, redactHosts)]
      }
      return [redactHosts(key), redactHostsInValue(value, redactHosts)]
    })
  )

const scrubRequest = <R extends ScrubbableRequest>(request: R, redactHosts: HostRedactor): R => ({
  ...request,
  ...(request.url === undefined ? {} : { url: anonymizeUrl(request.url) }),
  ...(request.query_string === undefined ? {} : { query_string: undefined }),
  ...(request.headers === undefined
    ? {}
    : { headers: scrubUrlBearingRecord(request.headers, redactHosts) }),
})

const scrubBreadcrumb = <B extends ScrubbableBreadcrumb>(
  breadcrumb: B,
  redactHosts: HostRedactor
): B => ({
  ...breadcrumb,
  ...(breadcrumb.message === undefined
    ? {}
    : { message: scrubText(breadcrumb.message, redactHosts) }),
  ...(breadcrumb.data === undefined
    ? {}
    : { data: scrubUrlBearingRecord(breadcrumb.data, redactHosts) }),
})

/**
 * `span` with its description scrubbed as free text and its data as
 * `scrubEvent` scrubs a span's: for a span the SDK sends on its own, outside
 * any event.
 *
 * @typeParam S - The SDK's span type; every other field passes through
 * @param redactHosts - As for {@link scrubEvent}
 *
 * @remarks
 * Pure and idempotent, like {@link scrubEvent}, which scrubs the spans of a
 * transaction event the same way.
 */
const scrubSpan = <S extends ScrubbableSpan>(
  span: S,
  redactHosts: HostRedactor = makeHostRedactor([])
): S => ({
  ...span,
  ...(span.description === undefined
    ? {}
    : { description: scrubText(span.description, redactHosts) }),
  ...(span.data === undefined ? {} : { data: scrubUrlBearingRecord(span.data, redactHosts) }),
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
 * `exception` with its message scrubbed (see {@link scrubText}) and the server
 * host in each stack frame's script URL replaced.
 *
 * @remarks
 * In a frame only the host is replaced: the path and file name stay, so the
 * frame still reads as the bundle it ran in.
 */
const scrubException = <X extends ScrubbableException>(
  exception: X,
  redactHosts: HostRedactor
): X => {
  const frames = exception.stacktrace?.frames
  return {
    ...exception,
    ...(exception.value === undefined ? {} : { value: scrubText(exception.value, redactHosts) }),
    ...(frames === undefined
      ? {}
      : {
          stacktrace: {
            ...exception.stacktrace,
            frames: frames.map((frame) =>
              redactHostsUnder(frame, ['filename', 'abs_path', 'module'], redactHosts)
            ),
          },
        }),
  }
}

/** `logentry` with its message and every string parameter scrubbed (see {@link scrubText}). */
const scrubLogEntry = <L extends NonNullable<ScrubbableEvent['logentry']>>(
  logentry: L,
  redactHosts: HostRedactor
): L => ({
  ...logentry,
  ...(logentry.message === undefined ? {} : { message: scrubText(logentry.message, redactHosts) }),
  ...(logentry.params === undefined
    ? {}
    : {
        params: logentry.params.map((param) =>
          typeof param === 'string'
            ? scrubText(param, redactHosts)
            : redactHostsInValue(param, redactHosts)
        ),
      }),
})

/**
 * `event` with every URL it carries anonymized, and every server host it
 * names replaced.
 *
 * @typeParam E - The SDK's event type; every other field passes through
 * @param redactHosts - Replaces the hosts the app is known to use (its own
 *   origin's, its servers'), built once by {@link makeHostRedactor} and kept
 *   while those hosts stay the same; relay tunnels alone by default
 * @returns A copy of `event` in which:
 *   - `request.url`, and a `Referer` request header, are anonymized, and
 *     `request.query_string` is cleared
 *   - each breadcrumb's and span's URL-valued data (`url`, `url.full`,
 *     `url.path`, `from`, `to`, and every key ending in `.url`) is
 *     anonymized, its script-valued data (`code.filepath`,
 *     `browser.script.invoker`) keeps only the scheme, host and path of an
 *     `http(s)` URL, its host-valued data (`server.address`, `url.domain`, `http.host`,
 *     `net.peer.name`) reduced to a kept host or `{host}`, and its query and
 *     fragment keys (`http.query`, `url.query`, …) and HTTP header attributes
 *     cleared
 *   - the free text — the message and `logentry` (its message and string
 *     parameters), each exception's message, each breadcrumb's message, each
 *     span description, the trace context's, the transaction name, and the
 *     `transaction` attribute in breadcrumb and span data — has the URLs in
 *     it anonymized
 *   - in all of the above, in each stack frame's `filename`, `abs_path` and
 *     `module`, each debug image's `code_file`, and every other string in
 *     breadcrumb and span data, tags, `extra` and contexts, every relay
 *     tunnel host (`*.relay.wildflowerhealth.io`) and every host
 *     `redactHosts` knows is replaced with `{host}`, the rest of the text kept as
 *     written
 *
 * @remarks
 * Pure and field-by-field: every rewrite copies the object it changes, so the
 * SDK's own event is left as it was. Idempotent: a scrubbed event scrubs to
 * itself.
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
  redactHosts: HostRedactor = makeHostRedactor([])
): E => ({
  ...event,
  ...(event.message === undefined ? {} : { message: scrubText(event.message, redactHosts) }),
  ...(event.logentry === undefined ? {} : { logentry: scrubLogEntry(event.logentry, redactHosts) }),
  ...(event.transaction === undefined
    ? {}
    : { transaction: scrubText(event.transaction, redactHosts) }),
  ...(event.request === undefined ? {} : { request: scrubRequest(event.request, redactHosts) }),
  ...(event.breadcrumbs === undefined
    ? {}
    : {
        breadcrumbs: event.breadcrumbs.map((breadcrumb) =>
          scrubBreadcrumb(breadcrumb, redactHosts)
        ),
      }),
  ...(event.spans === undefined
    ? {}
    : { spans: event.spans.map((span) => scrubSpan(span, redactHosts)) }),
  ...(event.contexts === undefined
    ? {}
    : {
        contexts: redactHostsInRecord(
          event.contexts.trace === undefined
            ? event.contexts
            : { ...event.contexts, trace: scrubSpan(event.contexts.trace, redactHosts) },
          redactHosts
        ),
      }),
  ...(event.exception?.values === undefined
    ? {}
    : {
        exception: {
          ...event.exception,
          values: event.exception.values.map((exception) => scrubException(exception, redactHosts)),
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
  ...(event.tags === undefined ? {} : { tags: redactHostsInRecord(event.tags, redactHosts) }),
  ...(event.extra === undefined ? {} : { extra: redactHostsInRecord(event.extra, redactHosts) }),
})

export type { ScrubbableEvent }
export { scrubEvent, scrubSpan }
