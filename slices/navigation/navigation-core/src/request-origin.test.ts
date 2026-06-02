import { Headers, HttpServerRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Origin } from './origin.ts'
import { requestOriginFromConnection, requestOriginFromRequest } from './request-origin.ts'

const FALLBACK = 'http://server.invalid'

describe('requestOriginFromConnection', () => {
  test('trusts a loopback IPv4 peer with a Host header and serves it over http', () => {
    expect(
      requestOriginFromConnection('127.0.0.1', { host: '127.0.0.1:3000' }, FALLBACK)
    ).toBe('http://127.0.0.1:3000')
  })

  test('trusts IPv6 loopback `::1`', () => {
    expect(requestOriginFromConnection('::1', { host: 'localhost:3000' }, FALLBACK)).toBe(
      'http://localhost:3000'
    )
  })

  test('trusts the IPv4-mapped IPv6 form `::ffff:127.0.0.1` (dual-stack sockets)', () => {
    expect(
      requestOriginFromConnection('::ffff:127.0.0.1', { host: '127.0.0.1:3000' }, FALLBACK)
    ).toBe('http://127.0.0.1:3000')
  })

  test('trusts X-Forwarded-{Host,Proto} when the peer is loopback (tunnel case)', () => {
    expect(
      requestOriginFromConnection(
        '127.0.0.1',
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'wildflower-node-dev.loca.lt',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe('https://wildflower-node-dev.loca.lt')
  })

  test('ignores forwarded headers when the peer is not loopback', () => {
    expect(
      requestOriginFromConnection(
        '203.0.113.1',
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'wildflower-node-dev.loca.lt',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe(FALLBACK)
  })

  test('falls back when remoteAddress is undefined', () => {
    expect(requestOriginFromConnection(undefined, { host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      FALLBACK
    )
  })

  test('falls back when the loopback peer has no Host and no forwarded pair', () => {
    expect(requestOriginFromConnection('127.0.0.1', {}, FALLBACK)).toBe(FALLBACK)
  })

  test('falls back when only one of the forwarded pair is present (loopback peer)', () => {
    expect(
      requestOriginFromConnection(
        '127.0.0.1',
        { host: '127.0.0.1:3000', 'x-forwarded-host': 'tunnel.example.com' },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
    expect(
      requestOriginFromConnection(
        '127.0.0.1',
        { host: '127.0.0.1:3000', 'x-forwarded-proto': 'https' },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
  })

  test('any non-loopback peer falls back regardless of header content', () => {
    // The richer invariant: for any non-loopback peer, the result is exactly
    // `FALLBACK` regardless of `Host` / `X-Forwarded-*`. Subsumes the
    // "ignores forwarded headers" example above across the whole non-loopback
    // address space.
    fc.assert(
      fc.property(
        fc.ipV4().filter((ip) => !/^127\./.test(ip)),
        fc.option(fc.domain(), { nil: undefined }),
        fc.option(fc.constantFrom('http', 'https', 'wss', 'ftp'), { nil: undefined }),
        (remoteAddress, forwardedHost, forwardedProto) => {
          const headers: Record<string, string> = { host: '127.0.0.1:3000' }
          if (forwardedHost !== undefined) headers['x-forwarded-host'] = forwardedHost
          if (forwardedProto !== undefined) headers['x-forwarded-proto'] = forwardedProto
          expect(requestOriginFromConnection(remoteAddress, headers, FALLBACK)).toBe(FALLBACK)
        }
      )
    )
  })
})

describe('requestOriginFromRequest', () => {
  const provideRequest = (
    remoteAddress: string | undefined,
    headers: Record<string, string>
  ): Layer.Layer<HttpServerRequest.HttpServerRequest> =>
    Layer.succeed(
      HttpServerRequest.HttpServerRequest,
      // `HttpServerRequest.fromWeb` wraps a fetch `Request` into a real
      // `HttpServerRequest`; `.modify` sets `headers` (bypassing the Fetch
      // spec's forbidden-name list for `host`) and `remoteAddress` (which
      // `fromWeb` always leaves as `None`). No casts needed.
      HttpServerRequest.fromWeb(new Request('http://test.invalid/')).modify({
        headers: Headers.fromInput(headers),
        remoteAddress,
      })
    )

  test('reads remoteAddress + headers from HttpServerRequest and threads through Origin', async () => {
    const run = requestOriginFromRequest.pipe(
      Effect.provide(provideRequest('127.0.0.1', { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe('http://127.0.0.1:3000')
  })

  test('falls back to the Origin layer when the peer is not loopback', async () => {
    const run = requestOriginFromRequest.pipe(
      Effect.provide(provideRequest('203.0.113.1', { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe(FALLBACK)
  })

  test('falls back when the platform exposes no remoteAddress', async () => {
    const run = requestOriginFromRequest.pipe(
      Effect.provide(provideRequest(undefined, { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe(FALLBACK)
  })
})
