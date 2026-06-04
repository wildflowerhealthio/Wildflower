import { Headers, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { corsMiddleware } from './corsMiddleware.ts'

const okApp = Effect.succeed(HttpServerResponse.text('ok', { status: 200 }))

const runCors = (
  method: string,
  headers: Record<string, string>
): Promise<HttpServerResponse.HttpServerResponse> => {
  const request = HttpServerRequest.fromWeb(new Request('http://test.invalid/', { method })).modify(
    {
      headers: Headers.fromInput(headers),
    }
  )
  return Effect.runPromise(
    corsMiddleware(okApp).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
  )
}

// Configured methods/headers — the test asserts the response advertises each
// of these. If `corsMiddleware` drops one (e.g. someone strips `Authorization`
// from `allowedHeaders`), the corresponding assertion fails and the
// regression is caught.
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'origin',
  'accept',
  'x-requested-with',
  'traceparent',
  'tracestate',
  'baggage',
  'sentry-trace',
]

describe('corsMiddleware', () => {
  test('OPTIONS preflight short-circuits with 204', async () => {
    const response = await runCors('OPTIONS', { origin: 'https://example.com' })
    expect(response.status).toBe(204)
  })

  test.each(ALLOWED_METHODS)(
    'OPTIONS preflight advertises configured method %s',
    async (method) => {
      const response = await runCors('OPTIONS', { origin: 'https://example.com' })
      const allowMethods = Option.getOrElse(
        Headers.get(response.headers, 'access-control-allow-methods'),
        () => ''
      )
      expect(allowMethods).toContain(method)
    }
  )

  test.each(ALLOWED_HEADERS)(
    'OPTIONS preflight advertises configured header %s',
    async (header) => {
      const response = await runCors('OPTIONS', { origin: 'https://example.com' })
      const allowHeaders = Option.getOrElse(
        Headers.get(response.headers, 'access-control-allow-headers'),
        () => ''
      )
      expect(allowHeaders).toContain(header)
    }
  )

  test('non-preflight requests are passed through to the inner app', async () => {
    // Non-OPTIONS responses get CORS headers via a pre-response handler the
    // server runtime executes; that step isn't reachable from a bare middleware
    // call, so this test only asserts pass-through. Browser-style CORS reply
    // headers on real requests are covered by `@effect/platform`'s own tests.
    const response = await runCors('GET', { origin: 'https://example.com' })
    expect(response.status).toBe(200)
  })

  test('preflight always advertises allow-origin: * regardless of Origin header', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.webUrl(), { nil: undefined }), async (origin) => {
        const headers: Record<string, string> = {}
        if (origin !== undefined) headers.origin = origin
        const response = await runCors('OPTIONS', headers)
        expect(Headers.get(response.headers, 'access-control-allow-origin')).toEqual(
          Option.some('*')
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
