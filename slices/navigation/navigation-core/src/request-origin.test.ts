import { Headers, HttpServerRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Origin } from './origin.ts'
import { requestOriginFromConnection, requestOriginFromHttpRequest } from './request-origin.ts'

const FALLBACK = 'http://server.invalid'

describe('requestOriginFromConnection', () => {
  test('trusts a loopback IPv4 peer with a Host header and serves it over http', () => {
    expect(requestOriginFromConnection('127.0.0.1', { host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      'http://127.0.0.1:3000'
    )
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

  test('falls back when remoteAddress is undefined', () => {
    expect(requestOriginFromConnection(undefined, { host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      FALLBACK
    )
  })

  test('falls back when the loopback peer has no Host and no forwarded pair', () => {
    expect(requestOriginFromConnection('127.0.0.1', {}, FALLBACK)).toBe(FALLBACK)
  })

  test('header lookup is case-sensitive — `Host` (capitalized) reads as absent', () => {
    // `@effect/platform` lowercases header keys (`Headers.fromInput`), so
    // a capitalized key here represents the test caller forgetting to
    // pre-lowercase. We pin the case-sensitive bare-function semantics so
    // callers don't accidentally bypass the trust gate.
    expect(requestOriginFromConnection('127.0.0.1', { Host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      FALLBACK
    )
  })

  test('empty `host` falls back', () => {
    expect(requestOriginFromConnection('127.0.0.1', { host: '' }, FALLBACK)).toBe(FALLBACK)
  })

  test('trailing-whitespace `host` falls back', () => {
    expect(requestOriginFromConnection('127.0.0.1', { host: '127.0.0.1:3000 ' }, FALLBACK)).toBe(
      FALLBACK
    )
  })

  test('comma-joined `x-forwarded-host` falls through to Host (not echoed as the tunnel URL)', () => {
    // `Headers.fromInput` collapses multi-value `x-forwarded-host` into a
    // comma-separated string. We don't try to parse it — anything that
    // doesn't match the host-shape regex is ignored and we fall through.
    expect(
      requestOriginFromConnection(
        '127.0.0.1',
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'a.example.com, b.example.com',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
  })

  test('non-http/https forwarded-proto falls through to Host', () => {
    expect(
      requestOriginFromConnection(
        '127.0.0.1',
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'tunnel.example.com',
          'x-forwarded-proto': 'javascript',
        },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
  })

  test('half-forwarded pair (loopback peer): result is the tunnel URL iff both present, else loopback Host', () => {
    // The 2×2 lattice of (forwardedHost present/absent, forwardedProto
    // present/absent) — only the both-present cell takes the tunnel URL,
    // every other cell echoes the loopback Host.
    fc.assert(
      fc.property(
        fc.option(fc.domain(), { nil: undefined }),
        fc.option(fc.constantFrom('http', 'https'), { nil: undefined }),
        (fwdHost, fwdProto) => {
          const headers: Record<string, string> = { host: '127.0.0.1:3000' }
          if (fwdHost !== undefined) headers['x-forwarded-host'] = fwdHost
          if (fwdProto !== undefined) headers['x-forwarded-proto'] = fwdProto
          const expected =
            fwdHost !== undefined && fwdProto !== undefined
              ? `${fwdProto}://${fwdHost}`
              : 'http://127.0.0.1:3000'
          expect(requestOriginFromConnection('127.0.0.1', headers, FALLBACK)).toBe(expected)
        }
      )
    )
  })

  test('any non-loopback peer falls back regardless of header content', () => {
    // The richer invariant: for any non-loopback peer, the result is
    // exactly `FALLBACK` — `Host`, `X-Forwarded-Host`, and
    // `X-Forwarded-Proto` are all ignored. Subsumes the targeted "ignores
    // forwarded headers when the peer is not loopback" example.
    fc.assert(
      fc.property(
        fc.ipV4().filter((ip) => !ip.startsWith('127.')),
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

describe('requestOriginFromHttpRequest', () => {
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
    const run = requestOriginFromHttpRequest.pipe(
      Effect.provide(provideRequest('127.0.0.1', { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe('http://127.0.0.1:3000')
  })

  test('fails closed with UntrustedRemotePeer when the peer is not loopback', async () => {
    const run = requestOriginFromHttpRequest.pipe(
      Effect.provide(provideRequest('203.0.113.1', { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    // A forged loopback `Host` from a non-loopback peer must never steer the
    // echoed origin, so the Effect fails rather than falling back to FALLBACK.
    const failure = await Effect.runPromise(Effect.flip(run))
    expect(failure._tag).toBe('UntrustedRemotePeer')
    expect(failure.remoteAddress).toBe('203.0.113.1')
  })

  test('fails closed with UntrustedRemotePeer when the platform exposes no remoteAddress', async () => {
    const run = requestOriginFromHttpRequest.pipe(
      Effect.provide(provideRequest(undefined, { host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    const failure = await Effect.runPromise(Effect.flip(run))
    expect(failure._tag).toBe('UntrustedRemotePeer')
    expect(failure.remoteAddress).toBeUndefined()
  })
})
