import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

// `app-query-runtime.ts` imports `webHttpClientLayer` from
// 'telemetry-react' at module scope, and that layer's construction
// eagerly installs the global OTel context manager and inits Sentry
// (see Learnings Inbox). `prependApiBaseUrl` never touches it — stub
// the module so this focused test stays side-effect-free.
vi.mock('telemetry-react', async () => {
  const { Layer: LayerActual } = await import('effect')
  return { webHttpClientLayer: LayerActual.empty }
})

import { prependApiBaseUrl } from './app-query-runtime.ts'

describe('prependApiBaseUrl', () => {
  test('prefixes a relative request path with the base URL', async () => {
    // Arrange
    const seenUrls: string[] = []
    const innerClient = capturingClientLayer(seenUrls)

    // Act
    await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/apps')).pipe(
      Effect.provide(prependApiBaseUrl(innerClient, 'http://127.0.0.1:8080')),
      Effect.runPromise
    )

    // Assert
    expect(seenUrls).toEqual(['http://127.0.0.1:8080/apps'])
  })

  test('hands back the inner client response unchanged', async () => {
    // Arrange
    const innerClient = capturingClientLayer([])

    // Act
    const body = await Effect.flatMap(HttpClient.HttpClient, (client) =>
      Effect.flatMap(client.get('/apps'), (response) => response.json)
    ).pipe(
      Effect.provide(prependApiBaseUrl(innerClient, 'http://127.0.0.1:8080')),
      Effect.runPromise
    )

    // Assert
    expect(body).toEqual([])
  })

  test('warns with the final URL when a response is not JSON', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const innerClient = htmlClientLayer()

      // Act
      await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/tunnel')).pipe(
        Effect.provide(prependApiBaseUrl(innerClient, 'http://127.0.0.1:8080')),
        Effect.runPromise
      )

      // Assert
      expect(warnSpy).toHaveBeenCalledWith(
        '[api] non-JSON response: GET http://127.0.0.1:8080/tunnel -> 200 text/html'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not warn on JSON responses', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const innerClient = capturingClientLayer([])

      // Act
      await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/apps')).pipe(
        Effect.provide(prependApiBaseUrl(innerClient, 'http://127.0.0.1:8080')),
        Effect.runPromise
      )

      // Assert
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// Helpers

/**
 * `HttpClient` stub that records each request's final URL and answers
 * every request with `200 []` (`application/json`) — just enough
 * surface to observe what URL the wrapper hands the inner client.
 */
const capturingClientLayer = (seenUrls: string[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seenUrls.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          new Response('[]', { headers: { 'content-type': 'application/json' } })
        )
      })
    )
  )

/**
 * `HttpClient` stub behaving like an SPA fallback: every request gets
 * `200` + HTML — the response shape that surfaces as the opaque
 * `Could not parse JSON` ParseError this wrapper's warning exists for.
 */
const htmlClientLayer = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          new Response('<!doctype html><title>Wildflower</title>', {
            headers: { 'content-type': 'text/html' },
          })
        )
      )
    )
  )
