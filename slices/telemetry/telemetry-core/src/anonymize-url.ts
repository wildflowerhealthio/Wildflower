/**
 * Reduces the URLs telemetry reports to the shape of the request: origin and
 * path, with FHIR resource ids and version ids replaced by placeholders and
 * the query string and fragment dropped.
 */

/** What {@link anonymizeUrl} reports for input it cannot read as a URL. */
const INVALID_URL_PLACEHOLDER = '{invalid-url}'

/** The path segment that stands in for a FHIR resource id. */
const RESOURCE_ID_PLACEHOLDER = '{id}'

/** The path segment that stands in for a FHIR version id after `_history`. */
const VERSION_ID_PLACEHOLDER = '{vid}'

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
 * Whether `segment` is shaped like a FHIR resource type: an uppercase letter,
 * a lowercase letter, then letters only (`Patient`, `MedicationRequest`).
 *
 * @remarks
 * Every FHIR R4 resource type has this shape; FHIR ids cannot (they allow
 * digits, `-` and `.`, and those that are letters only rarely lead with an
 * uppercase letter followed by a lowercase one). Base-path segments such as
 * `R4` or `FHIR` fail it, so they stay as written.
 */
const isResourceTypeSegment = (segment: string): boolean => /^[A-Z][a-z][A-Za-z]*$/.test(segment)

/**
 * Whether `segment` names a FHIR operation (`$everything`) or a FHIR
 * interaction path (`_search`, `_history`) rather than an id.
 */
const isInteractionSegment = (segment: string): boolean =>
  segment.startsWith('$') || segment.startsWith('_')

/**
 * The anonymized form of the path segment at `index` of `segments`.
 *
 * @remarks
 * Decided from the segment and the one before it in the input, never from an
 * earlier replacement: a segment after anything shaped like a resource type is
 * an id, so a resource type standing where an id should be (`/Foo/Patient/1`)
 * costs a readable segment rather than leaking the id after it.
 */
const anonymizePathSegment = (
  segment: string,
  index: number,
  segments: readonly string[]
): string => {
  const readable = placeholderByPercentEncoding.get(segment) ?? segment
  const encodedPrevious = segments[index - 1]
  if (encodedPrevious === undefined || readable === '') return readable
  if (isInteractionSegment(decodeAsciiOctets(readable))) return readable
  const previous = decodeAsciiOctets(encodedPrevious)
  if (previous === '_history') return VERSION_ID_PLACEHOLDER
  if (isResourceTypeSegment(previous)) return RESOURCE_ID_PLACEHOLDER
  return readable
}

/** `pathname` with its FHIR ids and version ids replaced by placeholders. */
const anonymizePathname = (pathname: string): string =>
  pathname.split('/').map(anonymizePathSegment).join('/')

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
 * @returns The anonymized URL in the form it was given: origin and path for an
 *   absolute URL, `//` host and path for a protocol-relative one, the path for
 *   the others; {@link INVALID_URL_PLACEHOLDER} for an absolute URL of another
 *   scheme, or input the URL parser rejects
 *
 * @remarks
 * The query string, the fragment and any credentials are dropped. In the path,
 * the segment after one shaped like a FHIR resource type becomes `{id}`, and
 * the segment after `_history` becomes `{vid}`; operations (`$everything`) and
 * interactions (`_search`) stay. Every other segment — the FHIR base path —
 * stays as written, so `https://fhir.example/r4/Patient/123/_history/2?x=1`
 * becomes `https://fhir.example/r4/Patient/{id}/_history/{vid}`, and
 * `Observation?patient=1` becomes `Observation`. Segments are classified with
 * their percent-encoded ASCII decoded, as the server reads them.
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
    return `${absoluteUrl.origin}${anonymizePathname(absoluteUrl.pathname)}`
  }
  if (!URL.canParse(url, RELATIVE_REFERENCE_BASE)) return INVALID_URL_PLACEHOLDER
  const resolvedUrl = new URL(url, RELATIVE_REFERENCE_BASE)
  const anonymizedPathname = anonymizePathname(resolvedUrl.pathname)
  if (resolvedUrl.host !== RELATIVE_REFERENCE_BASE.host) {
    return `//${resolvedUrl.host}${anonymizedPathname}`
  }
  if (resolvedUrl.pathname.startsWith(RELATIVE_REFERENCE_BASE.pathname)) {
    return asPathRelativeReference(
      anonymizedPathname.slice(RELATIVE_REFERENCE_BASE.pathname.length)
    )
  }
  return asRootRelativeReference(anonymizedPathname)
}

/**
 * Whether a whitespace-delimited token of free text is meant as a URL: an
 * absolute `http(s)` URL, or anything with a path separator, query or
 * fragment in it (`/Patient/1`, `Patient/1`, `Observation?patient=1`).
 */
const isUrlToken = (token: string): boolean => /^https?:/i.test(token) || /[/?#]/.test(token)

/**
 * `text` with every token that is meant as a URL (see `isUrlToken`) run
 * through {@link anonymizeUrl}.
 *
 * @remarks
 * For the free text telemetry carries URLs in: span descriptions
 * (`GET https://fhir.example/Patient/123`) and transaction names
 * (`/Patient/123`). Tokens are split on whitespace, which is kept as written;
 * everything that is not a URL stays as written too.
 */
const anonymizeUrlsInText = (text: string): string =>
  text
    .split(/(\s+)/)
    .map((token) => (isUrlToken(token) ? anonymizeUrl(token) : token))
    .join('')

export {
  anonymizeUrl,
  anonymizeUrlsInText,
  INVALID_URL_PLACEHOLDER,
  RESOURCE_ID_PLACEHOLDER,
  VERSION_ID_PLACEHOLDER,
}
