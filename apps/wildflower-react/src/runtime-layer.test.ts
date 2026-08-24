import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { RunAuthed, RuntimeLayer } from './router-context.ts'
import { buildRunAuthed } from './runtime-layer.ts'

describe('runAuthed runner', () => {
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
})

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

// Helpers

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
