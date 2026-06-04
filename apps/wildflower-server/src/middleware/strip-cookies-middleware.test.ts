import { Cookies, Headers, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { stripCookiesMiddleware } from './strip-cookies-middleware.ts'

// The middleware doesn't actually read the request, but `HttpMiddleware.make`
// returns an `HttpApp.Default<E, R>` which always carries `HttpServerRequest`
// in its requirements. Provide a stub so the program can `runPromise`.
const stubRequest = HttpServerRequest.fromWeb(new Request('http://test.invalid/'))

const runStrip = (
  response: HttpServerResponse.HttpServerResponse
): Promise<HttpServerResponse.HttpServerResponse> =>
  Effect.runPromise(
    stripCookiesMiddleware(Effect.succeed(response)).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, stubRequest)
    )
  )

const responseWithSetCookieHeader = (raw: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(HttpServerResponse.text('ok'), 'set-cookie', raw)

const responseWithCookies = (
  pairs: ReadonlyArray<readonly [name: string, value: string]>
): HttpServerResponse.HttpServerResponse => {
  let response: HttpServerResponse.HttpServerResponse = HttpServerResponse.text('ok')
  for (const [name, value] of pairs) {
    response = HttpServerResponse.unsafeSetCookie(response, name, value)
  }
  return response
}

// Cookie names and values must be safe to round-trip through @effect/platform's
// cookie API: ASCII, no control chars, no separators. The constraints here
// intentionally match what `unsafeSetCookie` will accept without throwing.
const cookieNameArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]*$/).filter((s) => s.length > 0)
const cookieValueArb = fc.stringMatching(/^[A-Za-z0-9_-]*$/)

describe('stripCookiesMiddleware', () => {
  test('passes through a response with no Set-Cookie header and no cookies', async () => {
    const inner = HttpServerResponse.text('hello', { status: 201 })
    const result = await runStrip(inner)
    expect(result).toBe(inner)
  })

  test('removes a Set-Cookie header', async () => {
    const result = await runStrip(responseWithSetCookieHeader('sid=abc; Path=/'))
    expect(Headers.has(result.headers, 'set-cookie')).toBe(false)
  })

  test('clears response cookies set via unsafeSetCookie', async () => {
    const result = await runStrip(responseWithCookies([['sid', 'abc']]))
    expect(Cookies.isEmpty(result.cookies)).toBe(true)
  })

  test('preserves status and body when stripping cookies', async () => {
    const inner = HttpServerResponse.unsafeSetCookie(
      HttpServerResponse.text('payload', { status: 418 }),
      'sid',
      'abc'
    )
    const result = await runStrip(inner)
    expect(result.status).toBe(418)
    expect(result.body).toBe(inner.body)
  })

  test('always emits a response with no cookie surface, for any cookie input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(cookieNameArb, cookieValueArb)),
        fc.option(cookieValueArb, { nil: undefined }),
        async (cookiePairs, rawSetCookie) => {
          let inner: HttpServerResponse.HttpServerResponse = HttpServerResponse.text('ok', {
            status: 200,
          })
          for (const [name, value] of cookiePairs) {
            inner = HttpServerResponse.unsafeSetCookie(inner, name, value)
          }
          if (rawSetCookie !== undefined) {
            inner = HttpServerResponse.setHeader(inner, 'set-cookie', `s=${rawSetCookie}`)
          }
          const result = await runStrip(inner)
          expect(Headers.has(result.headers, 'set-cookie')).toBe(false)
          expect(Cookies.isEmpty(result.cookies)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
