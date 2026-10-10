import { Headers, HttpServerRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Origin } from './origin.ts'
import {
  isLoopbackBindHost,
  requestOriginFromConnection,
  requestOriginFromHttpRequest,
} from './request-origin.ts'

const FALLBACK = 'http://server.invalid'

describe('requestOriginFromConnection', () => {
  test('echoes a Host header over http', () => {
    expect(requestOriginFromConnection({ host: '127.0.0.1:3000' }, FALLBACK)).toBe(
      'http://127.0.0.1:3000'
    )
  })

  test('echoes any DNS-shape Host (peer trust is gated upstream, not here)', () => {
    expect(requestOriginFromConnection({ host: 'localhost:3000' }, FALLBACK)).toBe(
      'http://localhost:3000'
    )
  })

  test('prefers X-Forwarded-{Host,Proto} when both are present (tunnel case)', () => {
    expect(
      requestOriginFromConnection(
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'wildflower-node-dev.loca.lt',
          'x-forwarded-proto': 'https',
        },
        FALLBACK
      )
    ).toBe('https://wildflower-node-dev.loca.lt')
  })

  test('falls back when there is no Host and no forwarded pair', () => {
    expect(requestOriginFromConnection({}, FALLBACK)).toBe(FALLBACK)
  })

  test('header lookup is case-sensitive — `Host` (capitalized) reads as absent', () => {
    // `@effect/platform` lowercases header keys (`Headers.fromInput`), so
    // a capitalized key here represents the test caller forgetting to
    // pre-lowercase. We pin the case-sensitive bare-function semantics.
    expect(requestOriginFromConnection({ Host: '127.0.0.1:3000' }, FALLBACK)).toBe(FALLBACK)
  })

  test('empty `host` falls back', () => {
    expect(requestOriginFromConnection({ host: '' }, FALLBACK)).toBe(FALLBACK)
  })

  test('trailing-whitespace `host` falls back', () => {
    expect(requestOriginFromConnection({ host: '127.0.0.1:3000 ' }, FALLBACK)).toBe(FALLBACK)
  })

  test('comma-joined `x-forwarded-host` falls through to Host (not echoed as the tunnel URL)', () => {
    // `Headers.fromInput` collapses multi-value `x-forwarded-host` into a
    // comma-separated string. We don't try to parse it — anything that
    // doesn't match the host-shape regex is ignored and we fall through.
    expect(
      requestOriginFromConnection(
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
        {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'tunnel.example.com',
          'x-forwarded-proto': 'javascript',
        },
        FALLBACK
      )
    ).toBe('http://127.0.0.1:3000')
  })

  test('half-forwarded pair: result is the tunnel URL iff both present, else the Host', () => {
    // The 2×2 lattice of (forwardedHost present/absent, forwardedProto
    // present/absent) — only the both-present cell takes the tunnel URL,
    // every other cell echoes the Host.
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
          expect(requestOriginFromConnection(headers, FALLBACK)).toBe(expected)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('requestOriginFromHttpRequest', () => {
  const provideRequest = (
    headers: Record<string, string>
  ): Layer.Layer<HttpServerRequest.HttpServerRequest> =>
    Layer.succeed(
      HttpServerRequest.HttpServerRequest,
      // `HttpServerRequest.fromWeb` wraps a fetch `Request` into a real
      // `HttpServerRequest`; `.modify` sets `headers` (bypassing the Fetch
      // spec's forbidden-name list for `host`). No casts needed.
      HttpServerRequest.fromWeb(new Request('http://test.invalid/')).modify({
        headers: Headers.fromInput(headers),
      })
    )

  test('derives the origin from request headers and threads through Origin', async () => {
    const run = requestOriginFromHttpRequest.pipe(
      Effect.provide(provideRequest({ host: '127.0.0.1:3000' })),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe('http://127.0.0.1:3000')
  })

  test('falls back to the configured Origin when no Host header is present', async () => {
    const run = requestOriginFromHttpRequest.pipe(
      Effect.provide(provideRequest({})),
      Effect.provide(Origin.layerFromLiteral(FALLBACK))
    )
    await expect(Effect.runPromise(run)).resolves.toBe(FALLBACK)
  })
})

describe('isLoopbackBindHost', () => {
  test.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback bind host %s',
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(true)
    }
  )

  test.each(['0.0.0.0', '::', '', '192.168.1.10', '10.0.0.5', '203.0.113.1', 'example.com', '::2'])(
    'rejects non-loopback bind host %s',
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(false)
    }
  )
})
