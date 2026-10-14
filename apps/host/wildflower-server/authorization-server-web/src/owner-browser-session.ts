import { HttpClient, HttpClientRequest } from '@effect/platform'
import { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { Effect, Layer, flow } from 'effect'

/**
 * The request header, and its value, by which a page asks the server's
 * cookie→bearer layer for the Owner browser session. A browser can also hold
 * the FHIR web UI's `hfs_session`, whose bearer the layer otherwise presents
 * when both cookies ride a request. With it, the request acts as the Owner
 * signed in on this browser, or as no session if none is; never as the UI's.
 * The server's side is `wildflowerhealthio-authorization-server`'s
 * `SESSION_HEADER` and `OWNER_BROWSER_SESSION_HEADER_VALUE`.
 */
const OWNER_BROWSER_SESSION_HEADER = {
  name: 'Wildflower-Session',
  value: 'owner-browser',
} as const

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
 * this browser. Every request carries {@link OWNER_BROWSER_SESSION_HEADER}, so
 * a browser also signed in to the FHIR web UI still acts as the Owner. A
 * browser with no Owner session gets the gates' `401`.
 */
const ownerBrowserSessionRunner = (
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
          HttpClientRequest.setHeader(
            OWNER_BROWSER_SESSION_HEADER.name,
            OWNER_BROWSER_SESSION_HEADER.value
          )
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

export { OWNER_BROWSER_SESSION_HEADER, ownerBrowserSessionRunner }
