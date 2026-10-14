import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, Tracer } from 'effect'
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

  it('should attach no Authorization header of its own (the entry decides)', async () => {
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

describe('runAuthed telemetry', () => {
  it('should run every authed request under the entry’s Effect telemetry layer', async () => {
    // Arrange — the entry's layer sets a tracer of its own
    const entryTracer = Tracer.make({
      span: () => {
        throw new Error('not used')
      },
      context: (execute) => execute(),
    })
    const { runAuthed } = buildRunAuthed(capturingHttpClientLayer([]), Layer.setTracer(entryTracer))

    // Act
    const tracer = await runAuthed(Effect.tracer)

    // Assert
    expect(tracer).toBe(entryTracer)
  })

  it('should trace the transport’s own HTTP spans with the entry’s tracer', async () => {
    // Arrange — the transport carries no telemetry of its own (as the real
    // `FetchHttpClient.layer` transport does not); the entry's layer records
    // every span Effect opens
    const spanNames: string[] = []
    const defaultTracer = Effect.runSync(Effect.tracer)
    const recordingTracer = Tracer.make({
      span: (...spanArgs: Parameters<Tracer.Tracer['span']>) => {
        spanNames.push(spanArgs[0])
        return defaultTracer.span(...spanArgs)
      },
      context: (execute, fiber) => defaultTracer.context(execute, fiber),
    })
    const { runAuthed } = buildRunAuthed(
      capturingHttpClientLayer([]),
      Layer.setTracer(recordingTracer)
    )

    // Act
    await runAuthed(fetchWithHttpInScope)

    // Assert
    expect(spanNames).toContain('http.client GET')
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
} => buildRunAuthed(capturingHttpClientLayer(captures), Layer.empty)

// Requires `HttpClient` and issues one request so the stub can record
// the (absent) Authorization header.
const fetchWithHttpInScope: Effect.Effect<number, never, HttpClient.HttpClient> = Effect.gen(
  function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get('/fixture'))
    return response.status
  }
).pipe(Effect.orDie)
