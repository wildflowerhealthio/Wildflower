import type { HttpClient } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import {
  buildSmartQueryClient,
  smartHttpClientLayer,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect, Layer } from 'effect'

import type { ServerSession } from './sign-in.ts'

/**
 * The router context every signed-in route reads: the authorization slice's
 * runner over the page's {@link ServerSession}, and the session itself, for
 * the page to say which server it manages.
 */
interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  readonly runtimeLayer: AuthorizationRouterContext.RuntimeLayer
  readonly awaitAuthReady: () => Promise<void>
  readonly session: ServerSession
}

/**
 * The base the shared API client's request paths resolve against.
 * `authorization-core`'s `AuthorizationServerApi` names each path with the
 * API's own `/authorization` prefix (`/authorization/grants`), the directory
 * the server advertises as `wildflower_authorization_api`, so requests resolve
 * against the directory above it.
 *
 * @example
 * apiRequestBaseUrl('https://ruth.wildflowerhealth.io/authorization/')
 * // → 'https://ruth.wildflowerhealth.io/'
 */
const apiRequestBaseUrl = (authorizationApiUrl: string): string =>
  new URL('..', authorizationApiUrl).href

/**
 * The router context for `session`: every request the authorization slice's
 * client makes goes to the server's authorization API with the session's
 * bearer, over `transport` (`FetchHttpClient.layer` in the browser, a stub in
 * tests). The bearer is in hand before this is built, so nothing is re-sent on a
 * 401: it is a real one.
 */
const buildRouterContext = (
  session: ServerSession,
  transport: Layer.Layer<HttpClient.HttpClient>,
  queryClient: QueryClient = buildSmartQueryClient()
): RouterContext => {
  const httpLayer = smartHttpClientLayer(
    {
      serverUrl: apiRequestBaseUrl(session.authorizationApiUrl),
      accessToken: session.accessToken,
    },
    transport
  )
  const runtimeLayer: AuthorizationRouterContext.RuntimeLayer = Layer.provideMerge(
    AuthorizationRouterContext.sliceRuntimeLayer,
    httpLayer
  )
  const runAuthed: AuthorizationRouterContext.RunAuthed = (effect, options) =>
    Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
  return {
    queryClient,
    runAuthed,
    runtimeLayer,
    awaitAuthReady: () => Promise.resolve(),
    session,
  }
}

export { apiRequestBaseUrl, buildRouterContext }
export type { RouterContext }
