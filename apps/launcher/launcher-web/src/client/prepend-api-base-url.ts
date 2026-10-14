import { HttpClient, HttpClientError, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'

/**
 * Wrap an `HttpClient` layer so every relative request's URL is prefixed with
 * the API base URL `readApiBaseUrl` gives at request time. The launcher is served from static hosting, cross-origin to its
 * API server, so a relative client path like `/apps` would otherwise resolve
 * against the page's own origin.
 *
 * `readApiBaseUrl` is read per request, not at layer-build time, so a sign-in
 * that moves the session to another server takes effect on the next request
 * without rebuilding the layer. A relative request made while it gives
 * `undefined` (no server signed in to in this tab) fails as a
 * `RequestError` (`InvalidUrl`) rather than go to the page's own origin.
 *
 * Prefix-only for *relative* URLs: an already-absolute URL is left
 * untouched. Prepending the base unconditionally would produce
 * `http://127.0.0.1:8080http://…`, which `fetch` then resolves against
 * the page origin — silent corruption. So an already-scheme-prefixed
 * URL passes through unchanged (the wrapper is a no-op for it).
 *
 * Non-JSON responses are logged with the final URL: every HttpApi
 * response on this client should be JSON, and the alternative is the
 * near-invisible `ParseError ... Could not parse JSON` (an SPA
 * fallback answering an API path with `200` + HTML carries no URL or
 * status in the failure it causes).
 *
 * @remarks
 * Apply it **once** per transport, with the whole prefix: a second wrapper
 * over a layer that already prefixed the origin never fires, because
 * `HttpClient.mapRequest` runs the wrapped client's rewrite first, so the outer
 * wrapper only sees an absolute URL.
 */
// URL is absolute when it leads with a scheme (`http:`, `https:`, `tauri:`, …).
// Matches RFC 3986's `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` so the
// prepend is skipped only for genuinely absolute URLs, never for relative paths like `/apps`.
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url)

const prependApiBaseUrl = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  readApiBaseUrl: () => string | undefined
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequestEffect((request) => {
          if (hasAbsoluteScheme(request.url)) return Effect.succeed(request)
          const apiBaseUrl = readApiBaseUrl()
          return apiBaseUrl === undefined
            ? Effect.fail(
                new HttpClientError.RequestError({
                  request,
                  reason: 'InvalidUrl',
                  description: 'no server is signed in to send it to',
                })
              )
            : Effect.succeed(HttpClientRequest.prependUrl(apiBaseUrl)(request))
        }),
        HttpClient.tap((response) =>
          Effect.sync(() => {
            const contentType = response.headers['content-type'] ?? '(none)'
            if (!contentType.includes('json') && ![204].includes(response.status)) {
              // oxlint-disable-next-line no-console
              console.warn(
                `[api] non-JSON response: ${response.request.method} ${response.request.url} -> ${response.status} ${contentType}`
              )
            }
          })
        )
      )
    )
  ).pipe(Layer.provide(httpClientLayer))

export { hasAbsoluteScheme, prependApiBaseUrl }
