import { HttpClient, HttpClientRequest } from '@effect/platform'
import { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { Effect, Layer } from 'effect'

/**
 * The runner every request an authorization page makes goes through: the
 * authorization API's client and plain FHIR reads, each path addressed to
 * `serverOrigin` (the page's own origin) over `transport`
 * (`FetchHttpClient.layer` in the browser, a stub in tests).
 *
 * @remarks
 * No request carries an `Authorization` header. The browser sends the Owner
 * browser session's `__Host-` cookie with every same-origin request, and the
 * server's cookie→bearer layer presents the session's token as the request's
 * bearer, so a page acts with exactly the authority of the Owner signed in on
 * this browser. A browser with no session gets the gates' `401`.
 */
const ownerBrowserSessionRunner = (
  serverOrigin: string,
  transport: Layer.Layer<HttpClient.HttpClient>
): AuthorizationRouterContext.RunAuthed => {
  const addressedTransport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.prependUrl(serverOrigin))
    )
  ).pipe(Layer.provide(transport))
  const runtimeLayer: AuthorizationRouterContext.RuntimeLayer = Layer.provideMerge(
    AuthorizationRouterContext.sliceRuntimeLayer,
    addressedTransport
  )
  return (effect, options) => Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
}

export { ownerBrowserSessionRunner }
