import { HttpServerRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Origin } from './origin.ts'
import { requestOriginFromHeaders, requestOriginFromRequest } from './request-origin.ts'

const FALLBACK = 'http://server.invalid'

describe('requestOriginFromHeaders', () => {
  test('trusts a 127.0.0.1 Host with no forwarding and serves it over http', () => {
    expect(requestOriginFromHeaders({ host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      'http://127.0.0.1:3000'
    )
  })

  test('trusts X-Forwarded-{Host,Proto} when the underlying Host is loopback', () => {
    expect(
      requestOriginFromHeaders(
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'wildflower-node-dev.loca.lt',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe('https://wildflower-node-dev.loca.lt')
  })

  test('ignores forwarded headers when the Host is not loopback', () => {
    expect(
      requestOriginFromHeaders(
        {
          host: 'evil.example.com',
          'x-forwarded-host': 'wildflower-node-dev.loca.lt',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe(FALLBACK)
  })

  test('falls back when Host is missing', () => {
    expect(requestOriginFromHeaders({}, FALLBACK)).toBe(FALLBACK)
  })

  test('falls back when only one of the forwarded pair is present', () => {
    expect(
      requestOriginFromHeaders(
        { host: '127.0.0.1:3000', 'x-forwarded-host': 'tunnel.example.com' },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
    expect(
      requestOriginFromHeaders({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https' }, FALLBACK)
    ).toBe('http://127.0.0.1:3000')
  })

  test('localhost is NOT treated as loopback (strict 127.0.0.1 only)', () => {
    expect(requestOriginFromHeaders({ host: 'localhost:3000' }, FALLBACK)).toBe(FALLBACK)
  })

  test('any non-127.0.0.1 host falls back to the configured Origin', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !/^127\.0\.0\.1$/.test(d)),
        (host) => {
          expect(requestOriginFromHeaders({ host }, FALLBACK)).toBe(FALLBACK)
        }
      )
    )
  })
})

describe('RequestOrigin.layer', () => {
  const provideRequest = (
    headers: Record<string, string>
  ): Layer.Layer<HttpServerRequest.HttpServerRequest> =>
    Layer.succeed(
      HttpServerRequest.HttpServerRequest,
      /* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub for HttpServerRequest;
         only `headers` is read by the layer. */
      { headers } as unknown as HttpServerRequest.HttpServerRequest
    )

  test('derives via fromRequest using the request headers and Origin fallback', async () => {
    const run = requestOriginFromRequest.pipe(
      Effect.provide(provideRequest({ host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe('http://127.0.0.1:3000')
  })

  test('falls back to the Origin layer when the Host is not loopback', async () => {
    const run = requestOriginFromRequest.pipe(
      Effect.provide(provideRequest({ host: 'someone-else.com' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe(FALLBACK)
  })
})
