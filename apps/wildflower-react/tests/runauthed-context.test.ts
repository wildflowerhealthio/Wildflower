import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, SubscriptionRef } from 'effect'
import fc from 'fast-check'
import { BearerToken } from 'kitchen-sink/auth-token'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { buildQueryClient, buildRunAuthed } from '../src/bridges/router-context.ts'
import type { RouterContext, RunAuthed } from '../src/bridges/router-context.ts'

/**
 * Pins the `runAuthed` runner this branch threads into the TanStack
 * Router {@link RouterContext}.
 *
 * Route `loader`s run OUTSIDE React, so they can't read the
 * React-provided bearer token or the React-composed slice client layers.
 * `app-root.tsx` calls `buildRunAuthed(authTokenRef, webHttpClientLayer)`
 * to build a long-lived authed `ManagedRuntime` and exposes its runner as
 * `runAuthed: <A, E>(effect: Effect<A, E, BearerToken | HttpClient>) => Promise<A>`.
 * A slice loader then runs `context.runAuthed(sliceEffect.pipe(Effect.provide(SliceClient.layer)))`,
 * where `SliceClient.layer` is what leaves `BearerToken | HttpClient`
 * unprovided.
 *
 * These tests drive the REAL {@link buildRunAuthed} factory — the same
 * one `renderApp` uses — with `BearerToken` sourced from a
 * `SubscriptionRef` (mirroring the real `authTokenRef`) over a STUB
 * `HttpClient` layer so the test runs offline, and assert the runner
 * supplies the token the ref currently holds to an effect that requires
 * `BearerToken` (and, by type, `HttpClient`). The stub HttpClient is
 * never asked to resolve a request here; its presence is what proves the
 * runner satisfies the full `BearerToken | HttpClient` requirement a real
 * slice client layer carries.
 */

// A stub `HttpClient` layer standing in for `webHttpClientLayer`: the
// tests never send a request through it — it exists only to satisfy the
// `HttpClient.HttpClient` half of the `runAuthed` requirement without
// pulling `fetch` / telemetry into the harness. Built from
// `HttpClient.make`, returning a never-used 204 response stub.
const stubHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
  )
)

// Build the production runner over the stub HTTP layer. Returns the
// runner plus its `dispose` so the test can release the runtime.
const makeRunner = (
  tokenRef: SubscriptionRef.SubscriptionRef<string | null>
): {
  readonly runAuthed: RunAuthed
  readonly dispose: () => Promise<void>
} => buildRunAuthed(tokenRef, stubHttpClientLayer)

// An effect requiring BOTH services `runAuthed` provides: it reads the
// live token via `BearerToken` (the behavior under test) and touches
// `HttpClient.HttpClient` only to require it in the type — proving a
// slice loader's `BearerToken | HttpClient` requirement is satisfiable
// by `runAuthed` with no `any` and no cast.
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
  const disposers: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()))
  })

  const trackRunner = (tokenRef: SubscriptionRef.SubscriptionRef<string | null>): RunAuthed => {
    const { runAuthed, dispose } = makeRunner(tokenRef)
    disposers.push(dispose)
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
    // Arrange — the runtime is built ONCE, mirroring the app's
    // page-lifetime runner; the token rotates afterwards. `BearerToken`
    // is a live `Subscribable`, so `.get` must see the new value without
    // rebuilding the runtime.
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('before'))
    const runAuthed = trackRunner(tokenRef)
    Effect.runSync(SubscriptionRef.set(tokenRef, 'after'))

    // Act
    const observed = await runAuthed(readTokenWithHttpInScope)

    // Assert
    expect(observed).toBe('after')
  })

  // For ANY token value the ref holds, the runner must hand the effect
  // exactly that value — the core contract loaders depend on. Property
  // form (over an arbitrary token, including the null edge) guards the
  // "always observes the ref's value" invariant rather than a single
  // hand-picked string.
  it('should always observe exactly the token the ref currently holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.string(), { nil: null }), async (token) => {
        // Arrange
        const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(token))
        const { runAuthed, dispose } = makeRunner(tokenRef)

        // Act
        const observed = await runAuthed(readTokenWithHttpInScope)
        await dispose()

        // Assert
        expect(observed).toBe(token)
      })
    )
  })

  // Type-level guard: the `RouterContext` this branch carries is exactly
  // `{ queryClient; runAuthed }`. A future edit that drops a field or
  // changes `runAuthed`'s requirement type fails to compile here, which
  // `vp check` surfaces. (`satisfies` keeps the literal honest without an
  // unsafe cast; the runner body is never invoked.)
  it('should type RouterContext as { queryClient; runAuthed }', () => {
    // Arrange / Act
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))
    const { runAuthed, dispose } = makeRunner(tokenRef)
    disposers.push(dispose)
    const context = {
      queryClient: buildQueryClient(),
      runAuthed,
    } satisfies RouterContext

    // Assert
    expect(typeof context.runAuthed).toBe('function')
    expect(context.queryClient).toBeDefined()
  })
})
