import { HttpClient, HttpClientRequest } from '@effect/platform'
import { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { Effect, Layer, flow } from 'effect'

/**
 * The request header, and its value, by which a page asks the server's
 * cookie→bearer layer for the browser session. A browser can also hold the
 * FHIR web UI's `hfs_session`, whose bearer the layer otherwise presents when
 * both cookies ride a request. With it, the request acts in the session this
 * browser is signed in with, or as no session if none is; never as the UI's.
 * The server's side is `wildflowerhealthio-authorization-server`'s
 * `SESSION_HEADER` and `BROWSER_SESSION_HEADER_VALUE`.
 */
const BROWSER_SESSION_HEADER = {
  name: 'Wildflower-Session',
  value: 'browser',
} as const

/**
 * The runner every request an authorization page makes goes through: the
 * authorization API's client and plain FHIR reads, each path addressed to
 * `serverOrigin` (the page's own origin) over `transport`
 * (`FetchHttpClient.layer` in the browser, a stub in tests).
 *
 * @remarks
 * No request carries an `Authorization` header. The browser sends its browser
 * session's `__Host-` cookie with every same-origin request, and the server's
 * cookie→bearer layer presents the session's token as the request's bearer, so
 * a page acts with exactly the authority of the session this browser is
 * signed in with (the Owner's, for a browser signed in as the Owner). Every
 * request carries {@link BROWSER_SESSION_HEADER}, so a browser also signed in
 * to the FHIR web UI still acts in its browser session. A browser with no
 * browser session gets the gates' `401`.
 */
const browserSessionRunner = (
  serverOrigin: string,
  transport: Layer.Layer<HttpClient.HttpClient>
): AuthorizationRouterContext.RunAuthed => {
  const addressedTransport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl(serverOrigin),
          HttpClientRequest.setHeader(BROWSER_SESSION_HEADER.name, BROWSER_SESSION_HEADER.value)
        )
      )
    )
  ).pipe(Layer.provide(transport))
  const runtimeLayer: AuthorizationRouterContext.RuntimeLayer = Layer.provideMerge(
    AuthorizationRouterContext.sliceRuntimeLayer,
    addressedTransport
  )
  return (effect, options) => Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
}

export { BROWSER_SESSION_HEADER, browserSessionRunner }
