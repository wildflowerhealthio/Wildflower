import type * as HttpResponse from './http-response.ts'

const UNKNOWN_CONTENT_TYPE = 'application/octet-stream'

/**
 * The response's `Content-Type`, lower-cased with its parameters stripped.
 *
 * @param headers - The response headers as received
 * @returns The bare media type, or `'application/octet-stream'` when absent or blank
 */
const contentTypeOf = (headers: HttpResponse.Headers): string => {
  const header = headers.find(([name]) => name.toLowerCase() === 'content-type')
  const mediaType = header?.[1].split(';')[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === '' ? UNKNOWN_CONTENT_TYPE : mediaType
}

const OMITTED_TYPES = new Set(['text/javascript', 'application/javascript', 'text/css'])
const OMITTED_TYPE_PREFIXES = ['image/', 'font/', 'audio/', 'video/']

/**
 * Whether a response with these headers should be omitted entirely from a
 * run recording — JavaScript, CSS, and media responses carry no clinical
 * payload and would only inflate the record.
 *
 * @param headers - The response headers as received
 * @returns `true` when the content type is one a recorder should drop
 */
const isOmittedContentType = (headers: HttpResponse.Headers): boolean => {
  const ct = contentTypeOf(headers)
  if (OMITTED_TYPES.has(ct)) return true
  return OMITTED_TYPE_PREFIXES.some((prefix) => ct.startsWith(prefix))
}

export { contentTypeOf, isOmittedContentType }
