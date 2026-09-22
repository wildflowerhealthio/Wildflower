import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'

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
 * `buildAppQueryRuntime`: prepend rewrites the URL, then this
 * wrapper attaches the bearer on the (now still relative, pre-fetch)
 * request.
 */
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url)

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
