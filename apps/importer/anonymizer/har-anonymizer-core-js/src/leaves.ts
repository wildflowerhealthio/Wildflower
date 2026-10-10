import { Effect, Schema } from 'effect'
import { JsonValue } from 'kitchen-sink/schema'

import type { TraceExchange } from 'web-trace-core'
import { contentTypeOf } from 'web-trace-core/capture'

import type { HttpArchive } from 'http-archive'
import { detectShape } from './shapes.ts'

/**
 * The single definition of what counts as a leaf in a {@link TraceExchange} —
 * which values are data (and get pseudonymized) and which are structure (and
 * survive verbatim).
 *
 * @remarks
 * Both passes of an export run through {@link mapExchangeLeaves}: the counting
 * pass that decides the enum carve-out, and the rewriting pass that produces the
 * redacted exchange. Sharing one traversal is what stops the two from drifting —
 * a value the counter never sees could otherwise be a value the rewriter never
 * redacts.
 *
 * The structure/data split itself, and its limits, are written up in
 * `../../docs/Anonymization Explanation.md`.
 *
 * @packageDocumentation
 */

/** A JSON value with no children — the granularity the pseudonymizer works at. */
type JsonLeaf = string | number | boolean | null

/**
 * The callbacks {@link mapExchangeLeaves} invokes at every leaf.
 *
 * @typeParam E - The error a visitor may fail with, propagated unchanged
 */
interface LeafVisitor<E> {
  /** Visits a leaf that is a string in its own right: a header or cookie value, a URL segment. */
  readonly visitString: (path: string, value: string) => Effect.Effect<string, E>
  /** Visits a leaf inside a decoded JSON body, where the value may be any JSON scalar. */
  readonly visitJsonLeaf: (path: string, value: JsonLeaf) => Effect.Effect<JsonLeaf, E>
}

/** Header names whose values are format, not data, and so are never rewritten. */
const STRUCTURAL_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'accept',
  'accept-encoding',
  'connection',
  'vary',
])

/** `Set-Cookie` attributes whose values are format, not data. */
const STRUCTURAL_COOKIE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'path',
  'domain',
  'samesite',
  'priority',
  'secure',
  'httponly',
  'partitioned',
])

const decodeBase64 = Schema.decodeSync(Schema.StringFromBase64)
const encodeBase64 = Schema.encodeSync(Schema.StringFromBase64)
const decodeJsonValue = Schema.decodeUnknownSync(JsonValue)
const utf8 = new TextEncoder()

/**
 * Whether a URL path segment reads as an identifier rather than a route name.
 *
 * @param segment - One decoded path segment
 * @returns `true` when the segment should be pseudonymized
 *
 * @remarks
 * A route name (`patients`, `v2`, `search`) is structure a collector author
 * needs; a record key (`8a3f…`, `10432`, `2024-01-05`) is data. The dividing
 * line is "does it carry a digit or a recognised identifier shape" — a word
 * survives, a word with a number in it does not.
 */
const looksLikeIdentifier = (segment: string): boolean => {
  if (segment === '') return false
  const shape = detectShape(segment)
  if (shape === 'alphanumericId') return /\d/.test(segment)
  return shape !== 'freeText'
}

/**
 * The path template a URL reduces to, with identifier-looking segments collapsed
 * to `*` — the key the enum carve-out counts distinct values under.
 *
 * @remarks
 * Counting per literal URL would give every record its own path and defeat the
 * carve-out entirely; counting per template groups `/patients/1` and
 * `/patients/2` so a field that is an enum across the session is recognized as
 * one.
 */
const pathTemplate = (url: URL): string =>
  url.pathname
    .split('/')
    .map((segment) => (looksLikeIdentifier(decodeSegment(segment)) ? '*' : segment))
    .join('/')

/** Path key for a URL path segment. */
const urlSegmentPath = (url: URL, template: string, index: number): string =>
  `path:${url.host}|${template}|${index}`

/** Path key for a query parameter, keyed by name alone so enums are seen session-wide. */
const queryPath = (name: string): string => `query:${name}`

/** Path key for a header value. */
const headerPath = (name: string): string => `header:${name.toLowerCase()}`

/** Path key for one cookie's value, inside `Cookie` or `Set-Cookie`. */
const cookiePath = (name: string): string => `cookie:${name}`

/** Path key for a `Set-Cookie` attribute's value. */
const cookieAttributePath = (name: string): string => `cookie-attr:${name.toLowerCase()}`

/** Path key for a JSON body leaf, with array indices collapsed so cardinality does not fragment paths. */
const bodyPath = (jsonPath: string): string => `body:${jsonPath}`

/** Path key for the body digest, which is a fingerprint of the original bytes. */
const BODY_HASH_PATH = 'body:hash'

const isJsonContentType = (contentType: string): boolean =>
  /(^|\/|\+)json($|;)/i.test(contentType.trim())

/** `null` rather than a throw for a URL the platform parser rejects. */
const tryParseUrl = (url: string): URL | null => {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * `undefined` for a body that is not base64 of parseable JSON — `null` is itself
 * a valid JSON body, so it cannot double as the failure signal.
 */
const tryParseJsonBody = (data: string): JsonValue | undefined => {
  try {
    return decodeJsonValue(JSON.parse(decodeBase64(data)))
  } catch {
    return undefined
  }
}

/** Malformed percent-encoding is left as-is rather than throwing mid-traversal. */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

const mapUrl = <E>(url: string, visit: LeafVisitor<E>): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const parsed = tryParseUrl(url)
    // A URL the platform parser rejects is treated as one opaque leaf rather
    // than picked apart with a hand-rolled parser.
    if (parsed === null) return yield* visit.visitString('url', url)

    const template = pathTemplate(parsed)
    const segments = parsed.pathname.split('/')
    const rewritten: string[] = []
    for (const [index, segment] of segments.entries()) {
      const decoded = decodeSegment(segment)
      rewritten.push(
        looksLikeIdentifier(decoded)
          ? encodeURIComponent(
              yield* visit.visitString(urlSegmentPath(parsed, template, index), decoded)
            )
          : segment
      )
    }
    parsed.pathname = rewritten.join('/')

    const query = new URLSearchParams()
    for (const [name, value] of parsed.searchParams) {
      query.append(name, value === '' ? value : yield* visit.visitString(queryPath(name), value))
    }
    parsed.search = query.toString()
    return parsed.toString()
  })

const mapCookieHeader = <E>(value: string, visit: LeafVisitor<E>): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const pairs: string[] = []
    for (const pair of value.split(';')) {
      const trimmed = pair.trim()
      const equals = trimmed.indexOf('=')
      if (equals <= 0) {
        pairs.push(trimmed)
        continue
      }
      const name = trimmed.slice(0, equals)
      const cookieValue = trimmed.slice(equals + 1)
      pairs.push(`${name}=${yield* visit.visitString(cookiePath(name), cookieValue)}`)
    }
    return pairs.join('; ')
  })

const mapSetCookieHeader = <E>(value: string, visit: LeafVisitor<E>): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const [first = '', ...attributes] = value.split(';')
    const trimmed = first.trim()
    const equals = trimmed.indexOf('=')
    const name = equals > 0 ? trimmed.slice(0, equals) : trimmed
    const cookieValue = equals > 0 ? trimmed.slice(equals + 1) : ''
    const head =
      equals > 0
        ? `${name}=${yield* visit.visitString(cookiePath(name), cookieValue)}`
        : yield* visit.visitString(cookiePath(name), trimmed)

    const rewrittenAttributes: string[] = []
    for (const attribute of attributes) {
      const attributeText = attribute.trim()
      const attributeEquals = attributeText.indexOf('=')
      if (attributeEquals <= 0) {
        rewrittenAttributes.push(attributeText)
        continue
      }
      const attributeName = attributeText.slice(0, attributeEquals)
      const attributeValue = attributeText.slice(attributeEquals + 1)
      rewrittenAttributes.push(
        STRUCTURAL_COOKIE_ATTRIBUTES.has(attributeName.toLowerCase())
          ? attributeText
          : `${attributeName}=${yield* visit.visitString(cookieAttributePath(attributeName), attributeValue)}`
      )
    }
    return [head, ...rewrittenAttributes].join('; ')
  })

const mapHeaders = <E>(
  headers: readonly (readonly [string, string])[],
  visit: LeafVisitor<E>
): Effect.Effect<readonly (readonly [string, string])[], E> =>
  Effect.gen(function* () {
    const mapped: (readonly [string, string])[] = []
    for (const [name, value] of headers) {
      const lower = name.toLowerCase()
      if (STRUCTURAL_HEADERS.has(lower)) {
        mapped.push([name, value] as const)
      } else if (lower === 'cookie') {
        mapped.push([name, yield* mapCookieHeader(value, visit)] as const)
      } else if (lower === 'set-cookie') {
        mapped.push([name, yield* mapSetCookieHeader(value, visit)] as const)
      } else {
        mapped.push([name, yield* visit.visitString(headerPath(name), value)] as const)
      }
    }
    return mapped
  })

const mapJson = <E>(
  value: JsonValue,
  jsonPath: string,
  visit: LeafVisitor<E>
): Effect.Effect<JsonValue, E> =>
  Effect.gen(function* () {
    if (Array.isArray(value)) {
      const mapped: JsonValue[] = []
      // Array indices collapse to `[]` in the path so that a hundred entries
      // read as one field with a hundred values, not a hundred one-value fields.
      for (const element of value) mapped.push(yield* mapJson(element, `${jsonPath}[]`, visit))
      return mapped
    }
    if (value !== null && typeof value === 'object') {
      const mapped: Record<string, JsonValue> = {}
      for (const [key, child] of Object.entries(value)) {
        mapped[key] = yield* mapJson(child, `${jsonPath}.${key}`, visit)
      }
      return mapped
    }
    return yield* visit.visitJsonLeaf(bodyPath(jsonPath), value)
  })

/**
 * Rewrites every leaf of one exchange through `visit`, leaving structure
 * untouched.
 *
 * @param exchange - The exchange to traverse
 * @param visit - Callbacks invoked once per leaf, in a stable order
 * @returns The exchange with every visitor result substituted in
 *
 * @remarks
 * A stored JSON body is decoded, walked, and re-encoded, with `size` recomputed
 * from the rewritten bytes. A stored body that is **not** JSON becomes a
 * `SkippedBody`: this module cannot pseudonymize HTML or binary content without
 * a format-specific parser, and shipping it unredacted at the export boundary is
 * not an option, so the export records what was dropped instead.
 *
 * The body `hash` is a leaf, not structure — a digest of the original bytes lets
 * a recipient confirm a guessed body, so the exported hash is a pseudonym. A
 * skipped body's `size` is left alone, because it is a fact about what was
 * dropped and identifies nothing on its own.
 */
const mapExchangeLeaves = <E>(
  exchange: TraceExchange,
  visit: LeafVisitor<E>
): Effect.Effect<TraceExchange, E> =>
  Effect.gen(function* () {
    const url = yield* mapUrl(exchange.url, visit)
    const headers = yield* mapHeaders(exchange.headers, visit)
    const hash = yield* visit.visitString(BODY_HASH_PATH, exchange.body.hash)

    if (exchange.body._tag === 'SkippedBody') {
      return { ...exchange, url, headers, body: { ...exchange.body, hash } }
    }

    if (!isJsonContentType(exchange.body.contentType)) {
      return {
        ...exchange,
        url,
        headers,
        body: {
          _tag: 'SkippedBody' as const,
          contentType: exchange.body.contentType,
          size: exchange.body.size,
          hash,
          reason: 'Non-JSON body dropped at the redaction boundary',
        },
      }
    }

    const parsed = tryParseJsonBody(exchange.body.data)

    if (parsed === undefined) {
      return {
        ...exchange,
        url,
        headers,
        body: {
          _tag: 'SkippedBody' as const,
          contentType: exchange.body.contentType,
          size: exchange.body.size,
          hash,
          reason: 'Body declared JSON but did not parse; dropped at the redaction boundary',
        },
      }
    }

    const redacted = JSON.stringify(yield* mapJson(parsed, '$', visit))
    return {
      ...exchange,
      url,
      headers,
      body: {
        ...exchange.body,
        data: encodeBase64(redacted),
        size: utf8.encode(redacted).length,
        hash,
      },
    }
  })

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * `undefined` for bytes that are not UTF-8-decodable parseable JSON — `null` is
 * itself a valid JSON body, so it cannot double as the failure signal.
 */
const tryParseJsonBytes = (bytes: Uint8Array): JsonValue | undefined => {
  try {
    return decodeJsonValue(JSON.parse(utf8Decoder.decode(bytes)))
  } catch {
    return undefined
  }
}

/**
 * Whether the entry's body is stored JSON the redactor can walk.
 *
 * @param entry - The archive entry to classify
 * @returns `true` for a present body whose declared content type is JSON
 *
 * @remarks
 * A DevTools/extension export can carry an HTML page or a binary asset next to
 * the FHIR responses — the redactor cannot pseudonymize a format it cannot
 * parse, and shipping one unredacted at the export boundary is not an option.
 * The count of dropped bodies is what surfaces the difference between what the
 * archive holds and what the export ships.
 */
const isJsonEntry = (entry: HttpArchive.Entry): boolean =>
  !entry.bodyAbsent && isJsonContentType(contentTypeOf(entry.headers))

/**
 * Rewrites every leaf of one archive entry through `visit`, leaving structure
 * untouched.
 *
 * @param entry - The archive entry to traverse
 * @param visit - Callbacks invoked once per leaf, in a stable order
 * @returns The entry with every visitor result substituted in
 *
 * @remarks
 * A JSON body is decoded from UTF-8, walked, re-encoded, and re-serialized to
 * UTF-8 bytes; the entry's `body` becomes the rewritten bytes. A non-JSON body
 * or one that fails to parse becomes an absent body (`bodyAbsent: true`, zero
 * bytes): the redactor cannot pseudonymize a format it cannot parse, and the
 * archive is deliberately explicit about that boundary — the manifest above
 * says how many were dropped, and the archive `log.comment` says why.
 *
 * `HttpArchive.Entry` carries no request side (the projection dropped it at
 * import), no body hash and no timings, so nothing here has to walk them.
 */
const mapEntryLeaves = <E>(
  entry: HttpArchive.Entry,
  visit: LeafVisitor<E>
): Effect.Effect<HttpArchive.Entry, E> =>
  Effect.gen(function* () {
    const url = yield* mapUrl(entry.url, visit)
    const headers = yield* mapHeaders(entry.headers, visit)

    if (!isJsonEntry(entry)) {
      return {
        ...entry,
        url,
        headers,
        body: new Uint8Array(0),
        bodyAbsent: true,
      }
    }

    const parsed = tryParseJsonBytes(entry.body)
    if (parsed === undefined) {
      return {
        ...entry,
        url,
        headers,
        body: new Uint8Array(0),
        bodyAbsent: true,
      }
    }

    const redacted = JSON.stringify(yield* mapJson(parsed, '$', visit))
    return {
      ...entry,
      url,
      headers,
      body: utf8.encode(redacted),
      bodyAbsent: false,
    }
  })

export {
  BODY_HASH_PATH,
  bodyPath,
  cookieAttributePath,
  cookiePath,
  headerPath,
  isJsonContentType,
  isJsonEntry,
  type JsonLeaf,
  type LeafVisitor,
  looksLikeIdentifier,
  mapEntryLeaves,
  mapExchangeLeaves,
  pathTemplate,
  queryPath,
  urlSegmentPath,
}
