import { DateTime } from 'effect'
import type { HttpResponse } from 'http-extraction-fundamentals'

import { CollectorHttpResponse } from './model/collector-http-response.ts'

/**
 * Fields a test wants to vary on a {@link CollectorHttpResponse}; everything omitted
 * takes a benign default.
 */
interface CollectorHttpResponseOverrides {
  readonly id?: string
  readonly url?: string
  readonly status?: number
  readonly statusText?: string
  readonly headers?: HttpResponse.Headers
  /** The observed response-start instant. Fixed by default, so tests stay deterministic. */
  readonly startedAt?: DateTime.Utc
  /** Body bytes. A `string` is UTF-8 encoded; pass a `Uint8Array` for a non-UTF-8 body. */
  readonly body?: string | Uint8Array
}

const utf8 = new TextEncoder()

/** The default {@link makeCollectorHttpResponse} `startedAt` — fixed, so tests are deterministic. */
const DEFAULT_STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

/**
 * Build a settled {@link CollectorHttpResponse} for a test, defaulting every field a
 * test does not care about.
 *
 * @param overrides - The fields to set; see {@link CollectorHttpResponseOverrides}
 * @returns A `CollectorHttpResponse` with `body` already appended as a single chunk
 *
 * @remarks
 * Six positional constructor arguments is a lot to restate at every call site,
 * and most tests care about one or two of them. Chunk *boundaries* are the one
 * thing this hides — a test about multi-chunk accumulation should call
 * `appendChunk` itself. For a plain `HttpResponse` with no chunk
 * machinery, use `http-extraction-fundamentals/test-helpers`' `makeHttpResponse`
 * instead.
 */
const makeCollectorHttpResponse = (
  overrides: CollectorHttpResponseOverrides = {}
): CollectorHttpResponse => {
  const response = new CollectorHttpResponse(
    overrides.id ?? 'req-1',
    overrides.url ?? 'https://example.com/resource/id',
    overrides.status ?? 200,
    overrides.statusText ?? 'OK',
    overrides.headers ?? [['content-type', 'application/json']],
    overrides.startedAt ?? DEFAULT_STARTED_AT
  )
  const body = overrides.body
  if (body !== undefined) {
    response.appendChunk(typeof body === 'string' ? utf8.encode(body) : body)
  }
  return response
}

export { DEFAULT_STARTED_AT, makeCollectorHttpResponse }
export type { CollectorHttpResponseOverrides }
