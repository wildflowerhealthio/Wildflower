import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import type { BaseRouterContext } from 'shared-structures-react'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { buildQueryClient } from './query-client.ts'
import type { RouterContext } from './router-context.ts'
import { buildRunAuthed } from './runtime-layer.ts'

// Pins `RouterContext['awaitAuthReady']` to the shared structural type
// — drift between the app-level context and the slice-published shape
// would silently break standalone slice route files (which read context
// via an annotated `select` typed against `BaseRouterContext`).
expectTypeOf<RouterContext['awaitAuthReady']>().toEqualTypeOf<BaseRouterContext.AwaitAuthReady>()

describe('RouterContext assembly', () => {
  // Type-level: a `satisfies` guard so dropping a field fails compile.
  // `awaitAuthReady` and `transport` are injected per entry (not built
  // by `buildRunAuthed`); the test supplies trivial resolvers to
  // complete the structural context, so this pins that `buildRunAuthed`'s
  // and `buildQueryClient`'s outputs together satisfy `RouterContext`.
  it('should type RouterContext with queryClient, runAuthed, runtimeLayer, awaitAuthReady, transport', () => {
    // Arrange / Act
    const { runAuthed, runtimeLayer } = buildRunAuthed(stubHttpClientLayer())
    const context = {
      queryClient: buildQueryClient(() => undefined),
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

// Helpers

// A trivial `HttpClient` layer answering `204`, enough to build a runner
// whose typed output completes the structural context above.
const stubHttpClientLayer = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    )
  )
