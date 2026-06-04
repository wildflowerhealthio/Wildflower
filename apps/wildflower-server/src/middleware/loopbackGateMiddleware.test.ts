import { Headers, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { loopbackGateMiddleware } from './loopbackGateMiddleware.ts'

// Wrap a trivially-succeeding inner `app` (a `200`) and assert the gate
// either lets it through or short-circuits with `403`, keyed solely on
// the connection-level `remoteAddress`. The `Host` header is held at a
// loopback literal throughout so the gate can't be passing on header
// content — only the peer address decides.
const statusFor = (remoteAddress: string | undefined): Promise<number> => {
  const okApp = Effect.succeed(HttpServerResponse.text('ok', { status: 200 }))
  const request = HttpServerRequest.fromWeb(new Request('http://test.invalid/')).modify({
    headers: Headers.fromInput({ host: '127.0.0.1:3000' }),
    remoteAddress,
  })
  return Effect.runPromise(
    loopbackGateMiddleware(okApp).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request)
    )
  ).then((response) => response.status)
}

describe('loopbackGateMiddleware', () => {
  test.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])(
    'admits loopback peer %s with the inner response (200)',
    async (remoteAddress) => {
      await expect(statusFor(remoteAddress)).resolves.toBe(200)
    }
  )

  test.each(['203.0.113.1', '192.168.1.10', '10.0.0.5', '::2'])(
    'rejects non-loopback peer %s with 403',
    async (remoteAddress) => {
      await expect(statusFor(remoteAddress)).resolves.toBe(403)
    }
  )

  test('rejects a peer with no remoteAddress (403)', async () => {
    // The platform leaves `remoteAddress` as `None` when transport info is
    // unavailable; an unknown peer is untrusted and must not reach the app.
    await expect(statusFor(undefined)).resolves.toBe(403)
  })

  test('rejects every IPv4 whose first octet is not 127 (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // `map` trick: skip 127 by remapping any value at/above it up by one.
        fc.integer({ min: 1, max: 254 }).map((n) => (n >= 127 ? n + 1 : n)),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        async (a, b, c, d) => {
          await expect(statusFor(`${a}.${b}.${c}.${d}`)).resolves.toBe(403)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('admits every IPv4 with first octet 127 (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        async (b, c, d) => {
          await expect(statusFor(`127.${b}.${c}.${d}`)).resolves.toBe(200)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
