import { HttpClient, HttpClientRequest } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import { Effect, Layer } from 'effect'
import { webHttpClientLayer } from 'telemetry-react'

import {
  buildQueryClient,
  buildRunAuthed,
  type RunAuthed,
  type RuntimeLayer,
} from '../router-context.ts'

/**
 * Wrap an `HttpClient` layer so every request's URL is prefixed with
 * `baseUrl`. For entries whose page is not served from the API origin
 * (the Tauri webview loads from the dev server / asset protocol while
 * the API lives on the host's loopback server), relative client paths
 * like `/apps` would otherwise resolve against the page origin.
 *
 * Prefix-only for *relative* URLs: an already-absolute URL is left
 * untouched. Prepending `baseUrl` unconditionally would produce
 * `http://127.0.0.1:8080http://…`, which `fetch` then resolves against
 * the page origin — silent corruption. So an already-scheme-prefixed
 * URL passes through unchanged (the wrapper is a no-op for it).
 *
 * Non-JSON responses are logged with the final URL: every HttpApi
 * response on this client should be JSON, and the alternative is the
 * near-invisible `ParseError ... Could not parse JSON` (an SPA
 * fallback answering an API path with `200` + HTML carries no URL or
 * status in the failure it causes).
 */
// URL is absolute when it leads with a scheme (`http:`, `https:`, `tauri:`, …).
// Matches RFC 3986's `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` so the
// prepend is skipped only for genuinely absolute URLs, never for relative paths like `/apps`.
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url)

const prependApiBaseUrl = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  baseUrl: string
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) =>
          hasAbsoluteScheme(request.url) ? request : HttpClientRequest.prependUrl(baseUrl)(request)
        ),
        HttpClient.tap((response) =>
          Effect.sync(() => {
            const contentType = response.headers['content-type'] ?? '(none)'
            if (!contentType.includes('json')) {
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

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every entry (the
 * embedded bridge carries only messages, not HTTP). Clients are
 * tokenless — auth rides the same-origin `HttpOnly` `wf_auth` cookie.
 *
 * @param apiBaseUrl - Absolute API origin for entries whose page isn't
 *   served by the API server (see {@link prependApiBaseUrl}). Omitted,
 *   requests stay relative to the page origin.
 */
const buildAppQueryRuntime = (
  apiBaseUrl?: string
): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient()
  const httpClientLayer =
    apiBaseUrl === undefined
      ? webHttpClientLayer
      : prependApiBaseUrl(webHttpClientLayer, apiBaseUrl)
  const { runAuthed, runtimeLayer } = buildRunAuthed(httpClientLayer)
  return { queryClient, runAuthed, runtimeLayer }
}

export { buildAppQueryRuntime, prependApiBaseUrl }
