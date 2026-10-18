/**
 * Reduces the URLs telemetry reports to the shape of the request: scheme,
 * host and path, with every host and path segment that could carry data
 * replaced by a placeholder and the query string and fragment dropped.
 *
 * Both are allowlists: a host stays only if it is one of Wildflower's own
 * fixed hosts, and a path segment stays only if it is shaped like a route
 * word or FHIR vocabulary. Anything else is replaced, so a shape this module
 * does not know costs readability rather than leaking.
 */

import { FHIR_RESOURCE_TYPES } from './fhir-resource-types.ts'

/** What {@link anonymizeUrl} reports for input it cannot read as a URL. */
const INVALID_URL_PLACEHOLDER = '{invalid-url}'

/**
 * The path segment that stands in for an id: a FHIR resource id, or any other
 * segment not shaped like a route word or FHIR vocabulary.
 */
const RESOURCE_ID_PLACEHOLDER = '{id}'

/** The path segment that stands in for a FHIR version id after `_history`. */
const VERSION_ID_PLACEHOLDER = '{vid}'

/**
 * The host that stands in for every host not in {@link KEPT_HOSTNAMES}. The
 * URL parser reads it back as the same host, so an anonymized URL stays one.
 */
const HOST_PLACEHOLDER = '{host}'

/**
 * The slug of each hosted web app, whose own origin is
 * `https://<slug>.wildflowerhealth.io/`. `branding-core`'s `APP_SLUGS` is the
 * source; `anonymize-url.test.ts` holds this copy to it (this package is
 * published and `branding-core` is not, so it cannot import it).
 */
const HOSTED_APP_SLUGS = [
  'medications',
  'importer',
  'server-docs',
  'ohif-viewer',
  'fhir-sync-pebble',
  'plots',
  'synthetic-data',
  'strength',
  'watch-lifts',
  'launcher',
  'authorization',
] as const

/**
 * The hostnames reported as written: the loopback names a dev server and the
 * Tauri webview load from, the apex `wildflowerhealth.io`, which serves the
 * marketing site, and each hosted web app's own subdomain of it. Any other
 * subdomain names a user's server or tunnel, so it is replaced like any other
 * host.
 */
const KEPT_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'tauri.localhost',
  'wildflowerhealth.io',
  ...HOSTED_APP_SLUGS.map((slug) => `${slug}.wildflowerhealth.io`),
])

/**
 * FHIR base-path segments that name a FHIR version or the FHIR endpoint
 * (`/api/FHIR/R4`, `/baseR4`), compared case-insensitively. A list rather
 * than a shape, so an uppercase code such as a device user code is not kept.
 */
const FHIR_BASE_SEGMENTS: ReadonlySet<string> = new Set([
  'fhir',
  'r4',
  'r4b',
  'r5',
  'stu3',
  'dstu2',
  'baser4',
  'baser4b',
  'baser5',
  'basedstu3',
])

/**
 * The placeholders as `URL` serialises them into a pathname, so a URL this
 * module already anonymized, or its {@link INVALID_URL_PLACEHOLDER} read as a
 * path-relative reference, reads back to the same placeholders.
 */
const placeholderByPercentEncoding: ReadonlyMap<string, string> = new Map(
  [RESOURCE_ID_PLACEHOLDER, VERSION_ID_PLACEHOLDER, INVALID_URL_PLACEHOLDER].map(
    (placeholder) => [encodeURIComponent(placeholder), placeholder] as const
  )
)

/**
 * The base a relative reference is resolved against. Its host and path tell
 * the form of the reference apart once the URL parser has read it: a
 * protocol-relative reference replaces the host, a root-relative one the path,
 * and a path-relative one stays under the path. Neither reaches the output.
 */
const RELATIVE_REFERENCE_BASE = new URL('http://relative-reference.invalid/relative-path/')

/**
 * `segment` with its percent-encoded ASCII octets decoded, so an encoded
 * resource type (`Pati%65nt`) or interaction (`%5Fhistory`) is recognized as
 * the server reads it. Octets outside ASCII stay encoded; only ASCII can make
 * a segment a resource type or an interaction.
 */
const decodeAsciiOctets = (segment: string): string =>
  segment.replace(/%([0-7][0-9A-Fa-f])/g, (_octet, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )

/**
 * Whether `segment` is a FHIR resource type (`Patient`, `MedicationRequest`),
 * one of {@link FHIR_RESOURCE_TYPES}. Base-path segments such as `R4` or
 * `FHIR` are not, so the segment after them is not taken for an id.
 */
const isResourceTypeSegment = (segment: string): boolean => FHIR_RESOURCE_TYPES.has(segment)

/**
 * Whether `segment` names a FHIR operation (`$everything`,
 * `$validate-code`) or a FHIR interaction path (`_search`, `_history`): a `$`
 * or `_`, then lowercase words joined by hyphens. Digits and other characters
 * fail it, so `$` or `_` in front of an id does not keep the id.
 */
const isInteractionSegment = (segment: string): boolean => /^[$_][a-z]+(-[a-z]+)*$/.test(segment)

/**
 * Whether `segment` is shaped like a fixed route word: lowercase words joined
 * by hyphens (`servers`, `oauth-consent`), with an optional leading `.`
 * (`.well-known`). Digits, dots between words and uppercase letters fail it,
 * so domains, UUIDs, numbers, user codes and file names do.
 */
const isRouteWordSegment = (segment: string): boolean => /^\.?[a-z]+(-[a-z]+)*$/.test(segment)

/** Whether `segment` is one of the {@link FHIR_BASE_SEGMENTS}. */
const isFhirBaseSegment = (segment: string): boolean =>
  FHIR_BASE_SEGMENTS.has(segment.toLowerCase())

/**
 * Whether `segment`, wherever it stands, is kept as written: a route word, a
 * FHIR resource type, operation, interaction or base-path name, or one of
 * this module's placeholders.
 */
const isReadableSegment = (segment: string): boolean =>
  isRouteWordSegment(segment) ||
  isResourceTypeSegment(segment) ||
  isInteractionSegment(segment) ||
  isFhirBaseSegment(segment) ||
  segment === RESOURCE_ID_PLACEHOLDER ||
  segment === VERSION_ID_PLACEHOLDER ||
  segment === INVALID_URL_PLACEHOLDER

/**
 * The route segment a routed SMART app names a patient's pages under
 * (`/patients/$patientId`), whose next segment is a FHIR patient id.
 */
const PATIENTS_ROUTE_SEGMENT = 'patients'

/**
 * The anonymized form of the path segment at `index` of `segments`.
 *
 * @remarks
 * An operation or interaction stays wherever it stands. Otherwise the segment
 * after `_history` becomes `{vid}` and the segment after a resource type, or
 * after a SMART app's `patients` route (`/patients/<id>/today`), becomes
 * `{id}`, whatever its own shape, since a FHIR id can be a plain word. Any other segment stays only if it is readable (see
 * `isReadableSegment`) and becomes `{id}` if not.
 *
 * Decided from the segment and the one before it in the input, never from an
 * earlier replacement: a resource type standing where an id should be
 * (`/Foo/Patient/1`) costs a readable segment rather than leaking the id after
 * it.
 */
const anonymizePathSegment = (
  segment: string,
  index: number,
  segments: readonly string[]
): string => {
  const readable = placeholderByPercentEncoding.get(segment) ?? segment
  if (readable === '') return readable
  const decoded = decodeAsciiOctets(readable)
  if (isInteractionSegment(decoded)) return readable
  const previous = decodeAsciiOctets(segments[index - 1] ?? '')
  if (previous === '_history') return VERSION_ID_PLACEHOLDER
  if (isResourceTypeSegment(previous) || previous === PATIENTS_ROUTE_SEGMENT) {
    return RESOURCE_ID_PLACEHOLDER
  }
  return isReadableSegment(decoded) ? readable : RESOURCE_ID_PLACEHOLDER
}

/** `pathname` with every segment that could carry data replaced by a placeholder. */
const anonymizePathname = (pathname: string): string =>
  pathname.split('/').map(anonymizePathSegment).join('/')

/**
 * `host` (a hostname and an optional port, as `URL.host` gives it) if its
 * hostname is in {@link KEPT_HOSTNAMES}, {@link HOST_PLACEHOLDER} with no port
 * otherwise.
 */
const anonymizeParsedHost = ({ host, hostname }: Pick<URL, 'host' | 'hostname'>): string =>
  KEPT_HOSTNAMES.has(hostname) ? host : HOST_PLACEHOLDER

/**
 * `pathname` written as a root-relative reference that reads back as the same
 * path: a leading `//` would read as a host, so it gets a `/.` in front.
 */
const asRootRelativeReference = (pathname: string): string =>
  pathname.startsWith('//') ? `/.${pathname}` : pathname

/**
 * `relativePath` written as a path-relative reference that reads back as the
 * same path: one the URL parser would read as absolute (`x:/y`) or as
 * root-relative gets a `./` in front.
 */
const asPathRelativeReference = (relativePath: string): string =>
  URL.canParse(relativePath) || /^[/\\]/.test(relativePath) ? `./${relativePath}` : relativePath

/**
 * `url` reduced to the shape of the request, safe to report as performance
 * data.
 *
 * @param url - An absolute `http:` or `https:` URL, or a relative reference:
 *   protocol-relative (`//fhir.example/Patient/1`), root-relative
 *   (`/fhir/Patient/1`) or path-relative (`Patient/1`)
 * @returns The anonymized URL in the form it was given: scheme, host and path
 *   for an absolute URL, `//` host and path for a protocol-relative one, the
 *   path for the others; {@link INVALID_URL_PLACEHOLDER} for an absolute URL
 *   of another scheme, or input the URL parser rejects
 *
 * @remarks
 * The query string, the fragment and any credentials are dropped.
 *
 * The host and port stay only when the hostname is one of
 * {@link KEPT_HOSTNAMES}: `localhost`, `tauri.localhost`, `wildflowerhealth.io`
 * itself or a hosted app's subdomain of it; any other host, any other
 * subdomain included, becomes {@link HOST_PLACEHOLDER} and its port is
 * dropped.
 *
 * In the path, the segment after a FHIR resource type, or after a SMART app's
 * `patients` route, becomes `{id}`, and the segment after `_history` becomes
 * `{vid}`. Every other
 * segment stays only if it is shaped like a fixed route word (`servers`,
 * `oauth-consent`, `.well-known`), or is a FHIR resource type, operation
 * (`$everything`), interaction (`_search`) or base-path name (`R4`, `FHIR`); anything else — a domain, a UUID, a number, a user code, a file
 * name — becomes `{id}`. So
 * `https://fhir.example/r4/Patient/123/_history/2?x=1` becomes
 * `https://{host}/r4/Patient/{id}/_history/{vid}`,
 * `/servers/android-emu.relay.wildflowerhealth.io` becomes `/servers/{id}`,
 * and `Observation?patient=1` becomes `Observation`. Segments are classified
 * with their percent-encoded ASCII decoded, as the server reads them.
 *
 * The form of `url` is the one the WHATWG URL parser reads, so input it
 * normalizes (surrounding spaces, tabs, backslashes) is classified as a
 * browser would request it.
 *
 * Idempotent: an anonymized URL anonymizes to itself.
 */
const anonymizeUrl = (url: string): string => {
  if (URL.canParse(url)) {
    const absoluteUrl = new URL(url)
    if (absoluteUrl.protocol !== 'http:' && absoluteUrl.protocol !== 'https:') {
      return INVALID_URL_PLACEHOLDER
    }
    return `${absoluteUrl.protocol}//${anonymizeParsedHost(absoluteUrl)}${anonymizePathname(absoluteUrl.pathname)}`
  }
  if (!URL.canParse(url, RELATIVE_REFERENCE_BASE)) return INVALID_URL_PLACEHOLDER
  const resolvedUrl = new URL(url, RELATIVE_REFERENCE_BASE)
  const anonymizedPathname = anonymizePathname(resolvedUrl.pathname)
  if (resolvedUrl.host !== RELATIVE_REFERENCE_BASE.host) {
    return `//${anonymizeParsedHost(resolvedUrl)}${anonymizedPathname}`
  }
  if (resolvedUrl.pathname.startsWith(RELATIVE_REFERENCE_BASE.pathname)) {
    return asPathRelativeReference(
      anonymizedPathname.slice(RELATIVE_REFERENCE_BASE.pathname.length)
    )
  }
  return asRootRelativeReference(anonymizedPathname)
}

/**
 * `host` read by the URL parser: an `http(s)` URL as written, anything else
 * as a host with an optional port (`fhir.example:8443`). `undefined` for input
 * the parser rejects, and for a non-URL holding anything but a host — a path,
 * a query, credentials or whitespace — so `/fhir` or `api/fhir` is never read
 * as the host `fhir` or `api`.
 */
const parseHost = (host: string): URL | undefined => {
  if (/^https?:/i.test(host)) return URL.parse(host) ?? undefined
  if (!/^[^/\\?#@\s]+$/.test(host)) return undefined
  return URL.parse(`http://${host}`) ?? undefined
}

/**
 * The hostname of `host` (see `parseHost`), lower-cased and without a
 * trailing dot (`ruth.example.` names `ruth.example`), when telemetry
 * replaces it; `undefined` for a kept hostname ({@link KEPT_HOSTNAMES}),
 * which telemetry reports as written, and for input that names no host.
 */
const redactableHostname = (host: string): string | undefined => {
  const hostname = parseHost(host)?.hostname.replace(/\.$/, '')
  return hostname === undefined || hostname === '' || KEPT_HOSTNAMES.has(hostname)
    ? undefined
    : hostname
}

/**
 * `host` reduced as {@link anonymizeUrl} reduces a URL's host, for the
 * telemetry fields that carry a host on its own.
 *
 * @param host - A host (`fhir.example:8443`), a hostname, or an `http(s)`
 *   origin (`https://fhir.example`)
 * @returns The host and port, behind the scheme for an origin, if the
 *   hostname is kept; {@link HOST_PLACEHOLDER} in their place otherwise, and
 *   for input the URL parser rejects
 *
 * @remarks
 * Idempotent: an anonymized host anonymizes to itself.
 */
const anonymizeHost = (host: string): string => {
  const parsed = parseHost(host)
  if (parsed === undefined) return HOST_PLACEHOLDER
  return /^https?:/i.test(host)
    ? `${parsed.protocol}//${anonymizeParsedHost(parsed)}`
    : anonymizeParsedHost(parsed)
}

/**
 * Whether a whitespace-delimited token of free text is meant as a URL: an
 * absolute `http(s)` URL, or anything with a path separator, query or
 * fragment in it (`/Patient/1`, `Patient/1`, `Observation?patient=1`).
 */
const isUrlToken = (token: string): boolean => /^https?:/i.test(token) || /[/?#]/.test(token)

/**
 * A whitespace-delimited token split into the punctuation prose wraps a URL
 * in — opening brackets and quotes in front; closing brackets, quotes and
 * sentence punctuation behind — and the token inside it. Braces are not
 * punctuation here, since they belong to this module's placeholders, and
 * neither is `?`, which `anonymizeUrl` drops with the query it starts.
 */
const WRAPPED_TOKEN = /^([(<["'`]*)(.*?)([)>\]"'`.,;:!]*)$/s

/** `token` with its URL anonymized, inside whatever punctuation wraps it. */
const anonymizeWrappedToken = (token: string): string => {
  const [, opening = '', inner = '', closing = ''] = WRAPPED_TOKEN.exec(token) ?? []
  return isUrlToken(inner) ? `${opening}${anonymizeUrl(inner)}${closing}` : token
}

/**
 * `text` with every token that is meant as a URL (see `isUrlToken`) run
 * through {@link anonymizeUrl}.
 *
 * @remarks
 * For the free text telemetry carries URLs in: span descriptions
 * (`GET https://fhir.example/Patient/123`), transaction names
 * (`/Patient/123`), and messages. Tokens are split on whitespace, which is
 * kept as written, and read without the punctuation around them, which is
 * kept too: `(https://wildflowerhealth.io/servers).` stays as written.
 * Everything that is not a URL stays as written. Anything else with a `/` in
 * it is read as a path, so a date such as `10/15/2026` reports
 * `{id}/{id}/{id}`: a date in a message can be a birth date.
 */
const anonymizeUrlsInText = (text: string): string =>
  text.split(/(\s+)/).map(anonymizeWrappedToken).join('')

export {
  anonymizeHost,
  anonymizeUrl,
  anonymizeUrlsInText,
  HOST_PLACEHOLDER,
  INVALID_URL_PLACEHOLDER,
  redactableHostname,
  RESOURCE_ID_PLACEHOLDER,
  VERSION_ID_PLACEHOLDER,
}
