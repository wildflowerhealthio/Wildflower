import { Headers, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { WildflowerHttpApi, loopbackGateMiddleware } from './index.ts'

/**
 * Regression guard for the slice-composer contract: `CollectorApi` lives
 * in `slices/collector/collector-core` without an internal
 * `.middleware(RequireAuthMiddleware)` annotation; the gating happens at
 * the server composition site (`addHttpApi(CollectorApi.middleware(...))`).
 * If a future edit drops the `.middleware(...)` call from
 * `apps/wildflower-server/src/index.ts`, the collector group's
 * `middlewares` set loses the `RequireAuthMiddleware` tag and write
 * endpoints silently expose to unauthenticated clients.
 *
 * `HttpApi` and each `HttpApiGroup` expose their applied middlewares as
 * a `ReadonlySet<TagClassAny>` (see `@effect/platform/HttpApi.d.ts`); the
 * regression check iterates the set and looks up the well-known tag
 * identifier `'RequireAuthMiddleware'`. Going through `.key` (the
 * Effect `Context.Tag` identifier) keeps the test independent of
 * `gatekeeper-core` class-identity variance.
 *
 * See `slices/collector/collector-core/src/http-api-definition/index.ts`
 * for the slice-side warning comment.
 */
const groupHasMiddleware = (
  groupName: keyof typeof WildflowerHttpApi.groups,
  middlewareKey: string
): boolean => {
  const group = WildflowerHttpApi.groups[groupName]
  if (group === undefined) return false
  for (const middleware of group.middlewares) {
    if (middleware.key === middlewareKey) return true
  }
  return false
}

describe('WildflowerHttpApi auth middleware regression guard', () => {
  test('collector group is gated by RequireAuthMiddleware', () => {
    expect(
      groupHasMiddleware('collector-remotes', 'RequireAuthMiddleware'),
      'collector-remotes group lost its RequireAuthMiddleware gate — auth must be reapplied at the server composition site'
    ).toBe(true)
  })

  test('fhir-r4 Patient group is gated by RequireAuthMiddleware', () => {
    // Sanity check: the same gating is also expected for the FHIR
    // resources API, which was already wired before this PR. If a
    // future composer drops it, this catches the regression too.
    expect(groupHasMiddleware('Patient', 'RequireAuthMiddleware')).toBe(true)
  })
})

describe('loopbackGateMiddleware', () => {
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
})
