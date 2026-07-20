import {
  HttpApiError,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { Duration, Effect, Either, Fiber, Layer, Ref, TestClock, TestContext } from 'effect'
import type { BaseRouterContext } from 'shared-structures-react'
import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

import {
  buildQueryClient,
  buildRunAuthed,
  insufficientScopeFromError,
  insufficientScopeFromFailure,
  isInsufficientScopeError,
  isUnauthorizedError,
  isUnauthorizedFailure,
  unauthorizedRetrySchedule,
} from './router-context.ts'
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

// A `ResponseError` carrying an empty body at `status` — the exact shape
// `HttpApiClient`'s `statusOrElse` / a `filterStatusOk` produces for a
// non-declared status, and the shape the 401 detection keys on.
const responseErrorWithStatus = (status: number): HttpClientError.ResponseError => {
  const request = HttpClientRequest.get('/fixture')
  return new HttpClientError.ResponseError({
    request,
    response: HttpClientResponse.fromWeb(request, new Response(null, { status })),
    reason: 'StatusCode',
  })
}

// The value a rejected `runAuthed` (i.e. a TanStack Query `queryFn`) surfaces:
// `Effect.runPromise` rejects with a `FiberFailure` wrapping the typed failure.
// Reproduces that exact wrapping so the detectors are tested against what they
// actually receive, not the bare error. Narrowed to `Error` (the `FiberFailure`
// is one) so callers get its `Error`-typed shape without an unsafe assertion.
const asFiberFailure = async (error: unknown): Promise<Error> => {
  try {
    await Effect.runPromise(Effect.fail(error))
    throw new Error('expected the effect to fail')
  } catch (caught) {
    if (caught instanceof Error) return caught
    throw new Error('expected a FiberFailure (Error) rejection', { cause: caught })
  }
}

describe('isUnauthorizedError', () => {
  it('is true only for a ResponseError carrying a 401', () => {
    expect(isUnauthorizedError(responseErrorWithStatus(401))).toBe(true)
    expect(isUnauthorizedError(responseErrorWithStatus(403))).toBe(false)
    expect(isUnauthorizedError(responseErrorWithStatus(500))).toBe(false)
  })

  it('is true for a typed HttpApiError.Unauthorized (a declared 401)', () => {
    // Gatekeeper's `/access` endpoints declare 401 via `RequireAuthMiddleware`,
    // so `HttpApiClient` decodes their 401s into this typed error, never a
    // `ResponseError`. The detector must catch it or the redirect/retry miss it.
    expect(isUnauthorizedError(new HttpApiError.Unauthorized())).toBe(true)
  })

  it('is false for values that are not a 401', () => {
    expect(isUnauthorizedError(new Error('boom'))).toBe(false)
    expect(isUnauthorizedError(null)).toBe(false)
    expect(isUnauthorizedError({ response: { status: 401 } })).toBe(false)
  })
})

describe('isUnauthorizedFailure', () => {
  it('unwraps a FiberFailure to recognize a wrapped 401', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(responseErrorWithStatus(401)))).toBe(true)
  })

  it('is false for a FiberFailure wrapping a non-401 ResponseError', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(responseErrorWithStatus(500)))).toBe(false)
  })

  it('is false for a FiberFailure wrapping an unrelated error', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(new Error('nope')))).toBe(false)
  })
})

// A decoded `403 InsufficientScope` body — the value a *declared* 403 surfaces
// on the Effect failure channel (not a `ResponseError`).
const insufficientScopeBody = {
  error: 'InsufficientScope',
  missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
} as const

describe('insufficientScopeFromError', () => {
  it('names the missing scopes for a decoded InsufficientScope body', () => {
    expect(insufficientScopeFromError(insufficientScopeBody)).toEqual({
      missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
    })
    expect(isInsufficientScopeError(insufficientScopeBody)).toBe(true)
  })

  it('detects a bare 403 ResponseError but cannot name the scopes', () => {
    // An *undeclared* 403 never has its body decoded, so the authorization
    // failure is still recognised (surface renders) but with no scope names.
    expect(insufficientScopeFromError(responseErrorWithStatus(403))).toEqual({ missingScopes: [] })
    expect(isInsufficientScopeError(responseErrorWithStatus(403))).toBe(true)
  })

  it('is null for a 401, a 500, and unrelated errors', () => {
    expect(insufficientScopeFromError(responseErrorWithStatus(401))).toBeNull()
    expect(insufficientScopeFromError(responseErrorWithStatus(500))).toBeNull()
    expect(insufficientScopeFromError(new Error('boom'))).toBeNull()
    expect(insufficientScopeFromError(null)).toBeNull()
    // A look-alike that isn't the real decoded body must not match.
    expect(insufficientScopeFromError({ error: 'InsufficientScope' })).toBeNull()
  })
})

describe('insufficientScopeFromFailure', () => {
  it('unwraps a FiberFailure wrapping a decoded body and names the scopes', async () => {
    expect(insufficientScopeFromFailure(await asFiberFailure(insufficientScopeBody))).toEqual({
      missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
    })
  })

  it('unwraps a FiberFailure wrapping a bare 403 ResponseError', async () => {
    expect(
      insufficientScopeFromFailure(await asFiberFailure(responseErrorWithStatus(403)))
    ).toEqual({ missingScopes: [] })
  })

  it('is null for a wrapped 401 (that path redirects, it does not surface in place)', async () => {
    expect(
      insufficientScopeFromFailure(await asFiberFailure(responseErrorWithStatus(401)))
    ).toBeNull()
  })
})

describe('unauthorizedRetrySchedule (boot-race retry)', () => {
  it('re-sends a persistent 401 the bounded number of times, then propagates', async () => {
    // Arrange / Act — driven on TestClock so the spacing is exercised without
    // real time.
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        () => Effect.fail(responseErrorWithStatus(401))
      )
      const fiber = yield* Effect.fork(
        Effect.either(Effect.retry(failing, unauthorizedRetrySchedule))
      )
      // Push past every spaced re-send.
      yield* TestClock.adjust(Duration.millis(1000))
      const result = yield* Fiber.join(fiber)
      return { result, count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { result, count } = await Effect.runPromise(program)

    // Assert — one initial send plus three re-sends, and it still fails.
    expect(count).toBe(4)
    expect(Either.isLeft(result)).toBe(true)
  })

  it('stops re-sending as soon as a 401 clears', async () => {
    // Arrange / Act — 401 twice, then the cookie has landed and it succeeds.
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const flaky = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        (n) => (n <= 2 ? Effect.fail(responseErrorWithStatus(401)) : Effect.succeed('ok'))
      )
      const fiber = yield* Effect.fork(Effect.retry(flaky, unauthorizedRetrySchedule))
      yield* TestClock.adjust(Duration.millis(1000))
      return { value: yield* Fiber.join(fiber), count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { value, count } = await Effect.runPromise(program)

    // Assert — resolved on the third attempt (two re-sends), no further sends.
    expect(value).toBe('ok')
    expect(count).toBe(3)
  })

  it('does not re-send a non-401 failure', async () => {
    // Arrange / Act
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        () => Effect.fail(responseErrorWithStatus(500))
      )
      const result = yield* Effect.either(Effect.retry(failing, unauthorizedRetrySchedule))
      return { result, count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { result, count } = await Effect.runPromise(program)

    // Assert — a single send, no re-send.
    expect(Either.isLeft(result)).toBe(true)
    expect(count).toBe(1)
  })
})

// `HttpClient` stub whose first request fails with a 401 `ResponseError` and
// whose second succeeds `204` — the boot-race shape (cookie lands between the
// two sends).
const flakyUnauthorizedThenOkLayer = (): Layer.Layer<HttpClient.HttpClient> => {
  let calls = 0
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      return calls === 1
        ? Effect.fail(
            new HttpClientError.ResponseError({
              request,
              response: HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
              reason: 'StatusCode',
            })
          )
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    })
  )
}

// Issues one request and returns its status, requiring only `HttpClient`.
const fetchStatus: Effect.Effect<number, HttpClientError.HttpClientError, HttpClient.HttpClient> =
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    Effect.map(client.execute(HttpClientRequest.get('/fixture')), (response) => response.status)
  )

describe('runAuthed boot-race integration', () => {
  it('re-sends a 401 and resolves once the request clears', async () => {
    // Arrange
    const { runAuthed } = buildRunAuthed(flakyUnauthorizedThenOkLayer())

    // Act — the first send 401s; the runner re-sends and gets the 204.
    const status = await runAuthed(fetchStatus)

    // Assert
    expect(status).toBe(204)
  })

  it('stops applying the boot-race retry once an authed request has succeeded', async () => {
    // Arrange — first request 204 (boots the runner), every later one 401.
    let calls = 0
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls += 1
        return calls === 1
          ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
          : Effect.fail(
              new HttpClientError.ResponseError({
                request,
                response: HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
                reason: 'StatusCode',
              })
            )
      })
    )
    const { runAuthed } = buildRunAuthed(layer)

    // Act — boot, then a genuine post-boot 401.
    expect(await runAuthed(fetchStatus)).toBe(204)
    const callsAfterBoot = calls
    await expect(runAuthed(fetchStatus)).rejects.toThrow()

    // Assert — the post-boot 401 was sent exactly once (no boot-race re-sends):
    // it's a real expiry, so it propagates immediately for the redirect.
    expect(calls - callsAfterBoot).toBe(1)
  })
})

describe('buildQueryClient unauthorized redirect', () => {
  it('invokes onUnauthorized when a query ends in a 401', async () => {
    // Arrange
    const onUnauthorized = vi.fn()
    const queryClient = buildQueryClient(onUnauthorized)
    const wrapped = await asFiberFailure(responseErrorWithStatus(401))

    // Act — mirror a rejected authed queryFn.
    await queryClient
      .fetchQuery({
        queryKey: ['unauthorized'],
        queryFn: () => Promise.reject(wrapped),
        retry: false,
      })
      .catch(() => undefined)

    // Assert
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('does not invoke onUnauthorized for a non-401 failure', async () => {
    // Arrange
    const onUnauthorized = vi.fn()
    const queryClient = buildQueryClient(onUnauthorized)
    const wrapped = await asFiberFailure(responseErrorWithStatus(500))

    // Act
    await queryClient
      .fetchQuery({
        queryKey: ['server-error'],
        queryFn: () => Promise.reject(wrapped),
        retry: false,
      })
      .catch(() => undefined)

    // Assert
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('skips TanStack retry for a 401 or a 403 but keeps the default count for other errors', async () => {
    // Arrange
    const queryClient = buildQueryClient(() => undefined)
    const retry = queryClient.getDefaultOptions().queries?.retry
    const wrapped401 = await asFiberFailure(responseErrorWithStatus(401))
    const wrapped403 = await asFiberFailure(insufficientScopeBody)
    const wrapped500 = await asFiberFailure(responseErrorWithStatus(500))

    // Assert — 401 and 403 (deterministic authz): never; others: the default
    // three attempts.
    expect(typeof retry).toBe('function')
    if (typeof retry === 'function') {
      expect(retry(0, wrapped401)).toBe(false)
      expect(retry(0, wrapped403)).toBe(false)
      expect(retry(0, wrapped500)).toBe(true)
      expect(retry(3, wrapped500)).toBe(false)
    }
  })
})
