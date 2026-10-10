import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'

import { hasAbsoluteScheme } from './prepend-api-base-url.ts'

/**
 * Wrap an `HttpClient` layer so every *relative* request carries an
 * `Authorization: Bearer <token>` header, read lazily from a
 * `readBearer` closure at request time (not at layer-build time, so
 * the header always reflects the latest token without rebuilding
 * the layer).
 *
 * Absolute URLs (another origin) are left untouched — the bearer is
 * only meaningful for the app's own API server, and leaking it to a
 * third-party origin would be a credential-exfiltration vector.
 *
 * When `readBearer` returns `undefined` (the user has signed out or
 * no token has been acquired yet), no header is attached and the
 * request goes unauthenticated — the server returns 401, which the
 * app's existing `onUnauthorized` handler picks up.
 *
 * Lives beside `prepend-api-base-url.ts` and composes with it in
 * `buildAppQueryRuntime`, which wraps this layer **first** and the
 * prepend around it. `HttpClient.mapRequest` chains preprocessing
 * inside-out — the inner client's transform runs first — so this
 * wrapper sees the still-relative path and the prepend rewrites the
 * URL afterwards. Reversing those two lines would hand this wrapper an
 * already-absolute URL, and the guard above would silently drop the
 * `Authorization` header from every request.
 */
const attachBearer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  readBearer: () => string | undefined
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          if (hasAbsoluteScheme(request.url)) return request
          const token = readBearer()
          if (token === undefined) return request
          return HttpClientRequest.setHeader('Authorization', `Bearer ${token}`)(request)
        })
      )
    )
  ).pipe(Layer.provide(httpClientLayer))

export { attachBearer }
