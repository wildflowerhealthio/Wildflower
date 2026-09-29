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
 * module already anonymized reads back to the same placeholders.
 */
const placeholderByPercentEncoding: ReadonlyMap<string, string> = new Map([
  [encodeURIComponent(RESOURCE_ID_PLACEHOLDER), RESOURCE_ID_PLACEHOLDER],
  [encodeURIComponent(VERSION_ID_PLACEHOLDER), VERSION_ID_PLACEHOLDER],
])

/**
 * The base a root-relative path is resolved against. Only the path of the
 * result is read, so the host never reaches the output.
 */
const ROOT_RELATIVE_BASE = 'http://root-relative.invalid'

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
  const previous = segments[index - 1]
  if (previous === undefined || readable === '' || isInteractionSegment(readable)) return readable
  if (previous === '_history') return VERSION_ID_PLACEHOLDER
  if (isResourceTypeSegment(previous)) return RESOURCE_ID_PLACEHOLDER
  return readable
}

/** `pathname` with its FHIR ids and version ids replaced by placeholders. */
const anonymizePathname = (pathname: string): string =>
  pathname.split('/').map(anonymizePathSegment).join('/')

/** Whether `url` is a path from the root of the current origin (`/fhir/Patient/1`). */
const isRootRelativePath = (url: string): boolean => url.startsWith('/') && !url.startsWith('//')

/**
 * `url` reduced to the shape of the request, safe to report as performance
 * data.
 *
 * @param url - An absolute `http:` or `https:` URL, or a root-relative path
 * @returns For an absolute URL, its origin and anonymized path; for a
 *   root-relative path, the anonymized path; for anything else,
 *   {@link INVALID_URL_PLACEHOLDER}
 *
 * @remarks
 * The query string, the fragment and any credentials are dropped. In the path,
 * the segment after one shaped like a FHIR resource type becomes `{id}`, and
 * the segment after `_history` becomes `{vid}`; operations (`$everything`) and
 * interactions (`_search`) stay. Every other segment — the FHIR base path —
 * stays as written, so `https://fhir.example/r4/Patient/123/_history/2?x=1`
 * becomes `https://fhir.example/r4/Patient/{id}/_history/{vid}`.
 *
 * Idempotent: an anonymized URL anonymizes to itself.
 */
const anonymizeUrl = (url: string): string => {
  if (isRootRelativePath(url)) return anonymizePathname(new URL(url, ROOT_RELATIVE_BASE).pathname)
  if (!URL.canParse(url)) return INVALID_URL_PLACEHOLDER
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return INVALID_URL_PLACEHOLDER
  }
  return `${parsedUrl.origin}${anonymizePathname(parsedUrl.pathname)}`
}

/** Whether a whitespace-separated token of free text is meant as a URL. */
const isUrlToken = (token: string): boolean => isRootRelativePath(token) || /^https?:/i.test(token)

/**
 * `text` with every token that is an absolute `http(s)` URL or a
 * root-relative path run through {@link anonymizeUrl}.
 *
 * @remarks
 * For the free text telemetry carries URLs in: span descriptions
 * (`GET https://fhir.example/Patient/123`) and transaction names
 * (`/Patient/123`). Tokens are split on single spaces, so the text keeps its
 * spacing; everything that is not a URL stays as written.
 */
const anonymizeUrlsInText = (text: string): string =>
  text
    .split(' ')
    .map((token) => (isUrlToken(token) ? anonymizeUrl(token) : token))
    .join(' ')

export {
  anonymizeUrl,
  anonymizeUrlsInText,
  INVALID_URL_PLACEHOLDER,
  RESOURCE_ID_PLACEHOLDER,
  VERSION_ID_PLACEHOLDER,
}
