import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import type { BaseRouterContext } from 'shared-structures-react'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { buildQueryClient, buildRunAuthed } from './router-context.ts'
import type { RouterContext, RunAuthed, RuntimeLayer } from './router-context.ts'

// Pins `RouterContext['awaitAuthReady']` to the shared structural type
// — drift between the app-level context and the slice-published shape
// would silently break standalone slice route files (which read context
// via an annotated `select` typed against `BaseRouterContext`).
expectTypeOf<RouterContext['awaitAuthReady']>().toEqualTypeOf<BaseRouterContext.AwaitAuthReady>()

/**
 * Pins `runAuthed`: drives the real `buildRunAuthed` over a stub
 * `HttpClient` so it runs offline. Clients are tokenless — auth rides
 * the same-origin cookie, so the runner supplies only `HttpClient`.
 */

// Stub that records the outgoing `Authorization` header (or `undefined`)
// and answers `204`.
const capturingHttpClientLayer = (
  captures: Array<string | undefined>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      captures.push(request.headers['authorization'])
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
      )
    })
  )

const makeRunner = (
  captures: Array<string | undefined>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => buildRunAuthed(capturingHttpClientLayer(captures))

// Requires `HttpClient` and issues one request so the stub can record
// the (absent) Authorization header.
const fetchWithHttpInScope: Effect.Effect<number, never, HttpClient.HttpClient> = Effect.gen(
  function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get('/fixture'))
    return response.status
  }
).pipe(Effect.orDie)

describe('runAuthed router-context runner', () => {
  it('should supply HttpClient to an effect requiring it', async () => {
    // Arrange
    const captures: Array<string | undefined> = []
    const { runAuthed } = makeRunner(captures)

    // Act
    const status = await runAuthed(fetchWithHttpInScope)

    // Assert
    expect(status).toBe(204)
  })

  it('should never attach an Authorization header (cookie auth)', async () => {
    // Arrange
    const captures: Array<string | undefined> = []
    const { runAuthed } = makeRunner(captures)

    // Act
    await runAuthed(fetchWithHttpInScope)
    await runAuthed(fetchWithHttpInScope)

    // Assert
    expect(captures).toEqual([undefined, undefined])
  })

  // Type-level: a `satisfies` guard so dropping a field fails compile.
  // `awaitAuthReady` and `transport` are injected per entry (not built
  // by `buildRunAuthed`); the test supplies trivial resolvers to
  // complete the structural context.
  it('should type RouterContext with queryClient, runAuthed, runtimeLayer, awaitAuthReady, transport', () => {
    // Arrange / Act
    const { runAuthed, runtimeLayer } = makeRunner([])
    const context = {
      queryClient: buildQueryClient(),
      runAuthed,
      runtimeLayer,
      awaitAuthReady: () => Promise.resolve(),
      transport: Promise.resolve({
        sendMessage: () => Effect.void,
        coordinator: { register: () => Effect.void, unregister: () => Effect.void },
      }),
    } satisfies RouterContext

    // Assert
    expect(typeof context.runAuthed).toBe('function')
    expect(typeof context.awaitAuthReady).toBe('function')
    expect(context.transport).toBeInstanceOf(Promise)
    expect(context.queryClient).toBeDefined()
  })
})
