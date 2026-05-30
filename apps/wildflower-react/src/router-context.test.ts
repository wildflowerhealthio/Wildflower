import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, SubscriptionRef } from 'effect'
import fc from 'fast-check'
import { BearerToken } from 'kitchen-sink/auth-token'
import { describe, expect, it } from 'vite-plus/test'

import { buildQueryClient, buildRunAuthed } from './router-context.ts'
import type { RouterContext, RunAuthed, RuntimeLayer } from './router-context.ts'

/**
 * Pins `runAuthed`: drives the real `buildRunAuthed` over a
 * `SubscriptionRef` token and a stub `HttpClient` so it runs offline.
 */

// Stub: never resolves a request; present only to satisfy the
// `HttpClient.HttpClient` half of `runAuthed`'s requirement.
const stubHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
  )
)

const makeRunner = (
  tokenRef: SubscriptionRef.SubscriptionRef<string | null>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => buildRunAuthed(tokenRef, stubHttpClientLayer)

// Requires both services so the type carries `BearerToken | HttpClient`.
const readTokenWithHttpInScope: Effect.Effect<
  string | null,
  never,
  BearerToken | HttpClient.HttpClient
> = Effect.gen(function* () {
  yield* HttpClient.HttpClient
  const tokenSubscribable = yield* BearerToken
  return yield* tokenSubscribable.get
})

describe('runAuthed router-context runner', () => {
  const trackRunner = (tokenRef: SubscriptionRef.SubscriptionRef<string | null>): RunAuthed => {
    const { runAuthed } = makeRunner(tokenRef)
    return runAuthed
  }

  it('should supply the current bearer token to an effect requiring BearerToken + HttpClient', async () => {
    // Arrange
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('initial-token'))
    const runAuthed = trackRunner(tokenRef)

    // Act
    const observed = await runAuthed(readTokenWithHttpInScope)

    // Assert
    expect(observed).toBe('initial-token')
  })

  it('should supply a null token when the ref holds none', async () => {
    // Arrange
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))
    const runAuthed = trackRunner(tokenRef)

    // Act
    const observed = await runAuthed(readTokenWithHttpInScope)

    // Assert
    expect(observed).toBeNull()
  })

  it('should observe a rotation written to the ref after the runtime was built', async () => {
    // Build once, rotate after — token must surface without rebuild.
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('before'))
    const runAuthed = trackRunner(tokenRef)
    Effect.runSync(SubscriptionRef.set(tokenRef, 'after'))

    // Act
    const observed = await runAuthed(readTokenWithHttpInScope)

    // Assert
    expect(observed).toBe('after')
  })

  it('should always observe exactly the token the ref currently holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.string(), { nil: null }), async (token) => {
        // Arrange
        const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(token))
        const { runAuthed } = makeRunner(tokenRef)

        // Act
        const observed = await runAuthed(readTokenWithHttpInScope)

        // Assert
        expect(observed).toBe(token)
      })
    )
  })

  // Type-level: a `satisfies` guard so dropping a field fails compile.
  // `awaitAuthReady` is injected per entry (not built by
  // `buildRunAuthed`), so the test supplies a trivial resolver to
  // complete the structural context.
  it('should type RouterContext as { queryClient; runAuthed; runtimeLayer; awaitAuthReady }', () => {
    // Arrange / Act
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))
    const { runAuthed, runtimeLayer } = makeRunner(tokenRef)
    const context = {
      queryClient: buildQueryClient(),
      runAuthed,
      runtimeLayer,
      awaitAuthReady: () => Promise.resolve(),
    } satisfies RouterContext

    // Assert
    expect(typeof context.runAuthed).toBe('function')
    expect(typeof context.awaitAuthReady).toBe('function')
    expect(context.queryClient).toBeDefined()
  })
})
