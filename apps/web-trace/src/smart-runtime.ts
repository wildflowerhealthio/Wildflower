import { HttpClient, HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Duration, Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { FhirResourcesApiPrefix } from 'fhir-r4/http-api-definition'

/**
 * The router context `web-trace-react` reads through — this app's instantiation
 * of the shared shape, narrowed to the one slice client it needs.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext
type RunAuthed = FhirR4ResourcesRouterContext.RunAuthed
type RuntimeLayer = FhirR4ResourcesRouterContext.RuntimeLayer

/**
 * The SMART handshake resolved to the two facts this app's HTTP layer needs.
 *
 * @remarks
 * Deliberately not a `fhirclient` `Client`: keeping the seam to primitives means
 * the runtime below is testable without a SMART handshake, and this module never
 * has to name a `fhirclient` type.
 */
interface SmartSession {
  /** The SMART `iss` — the FHIR server base, e.g. `https://host/fhir-r4`. */
  readonly serverUrl: string
  /** The bearer token from the token exchange, or `undefined` for an open server. */
  readonly accessToken: string | undefined
}

/**
 * The `iss` did not name a FHIR base this app's typed client can address.
 *
 * @remarks
 * Thrown rather than papered over. The typed client's own paths already carry
 * the `/fhir-r4` prefix (see {@link apiBaseUrlFromIss}), so an `iss` without it
 * has no correct prefix to derive — every request would go somewhere plausible
 * and wrong, and the failure would surface as a 404 with no explanation.
 */
class UnexpectedFhirBase extends Error {
  // Declared and assigned rather than a constructor parameter property:
  // `erasableSyntaxOnly` rejects the shorthand.
  readonly iss: string

  constructor(iss: string) {
    super(
      `SMART iss ${iss} does not end in ${FhirResourcesApiPrefix}, so this app cannot address it`
    )
    this.name = 'UnexpectedFhirBase'
    this.iss = iss
  }
}

/**
 * The origin-and-path prefix to put in front of the typed client's request URLs,
 * derived from the SMART `iss`.
 *
 * @remarks
 * The launch template hands the app `iss={origin}/fhir-r4`, while
 * `FhirResourcesApi` already prefixes every endpoint path with `/fhir-r4`.
 * Prepending the `iss` verbatim would produce `{origin}/fhir-r4/fhir-r4/…`, so
 * the suffix is removed here — the one place the two halves are reconciled.
 *
 * A trailing slash is tolerated (`{origin}/fhir-r4/`); anything else raises
 * {@link UnexpectedFhirBase} rather than guessing at an origin.
 *
 * @param iss - The SMART issuer, i.e. `client.state.serverUrl`
 * @returns The prefix, with no trailing slash
 * @throws UnexpectedFhirBase When `iss` does not end in the API's own prefix
 */
const apiBaseUrlFromIss = (iss: string): string => {
  const trimmed = iss.replace(/\/+$/u, '')
  if (!trimmed.endsWith(FhirResourcesApiPrefix)) throw new UnexpectedFhirBase(iss)
  return trimmed.slice(0, -FhirResourcesApiPrefix.length)
}

/** True when `url` leads with a scheme, per RFC 3986's `scheme` production. */
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/iu.test(url)

/**
 * Wrap an `HttpClient` layer so every relative request is addressed to the FHIR
 * server and carries the SMART bearer token.
 *
 * @remarks
 * Both halves are needed because a self-hosted app is served from its **own**
 * origin (`http://127.0.0.1:8091/` on device), not the API's. Left alone, the
 * typed client's relative `/fhir-r4/…` paths would resolve against the app's
 * origin, and the API's `wf_auth` cookie — which is what authenticates the
 * host's own webview — is not sent cross-origin. So this app authenticates the
 * way any third-party SMART app does: with the token it was granted.
 *
 * The prefix is applied to *relative* URLs only. Prepending it to an
 * already-absolute URL yields `http://host…http://…`, which `fetch` then
 * resolves against the page origin — silent corruption rather than a failure.
 *
 * A session with no `accessToken` sets no header at all, rather than an empty
 * `Bearer `: an absent credential must read as absent.
 *
 * The token rides only the requests this layer *addressed* — i.e. the relative
 * paths the typed client emits, which the prefix sends to the FHIR server. An
 * already-absolute URL names an origin the session never granted anything for,
 * so it goes out bare: a credential must never leave for a host that did not
 * issue it.
 *
 * The transport is a parameter rather than baked in — the same shape as
 * `apps/wildflower-react`'s `prependApiBaseUrl` — so what goes on the wire can
 * be asserted against a stub instead of a real `fetch`.
 *
 * @param session - The FHIR base and bearer token from the SMART handshake
 * @param transport - The underlying `HttpClient` this wraps
 * @returns The wrapped layer
 * @throws UnexpectedFhirBase When `session.serverUrl` is not addressable
 */
const smartHttpClientLayer = (
  session: SmartSession,
  transport: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<HttpClient.HttpClient> => {
  const baseUrl = apiBaseUrlFromIss(session.serverUrl)
  const { accessToken } = session
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          if (hasAbsoluteScheme(request.url)) return request
          const addressed = HttpClientRequest.prependUrl(baseUrl)(request)
          return accessToken === undefined
            ? addressed
            : HttpClientRequest.bearerToken(accessToken)(addressed)
        })
      )
    )
  ).pipe(Layer.provide(transport))
}

/**
 * The router context the app threads into its router, built from a completed
 * SMART handshake.
 *
 * @remarks
 * The transport is a parameter for the same reason
 * {@link smartHttpClientLayer}'s is: the app's whole tree can then be mounted
 * over a stub in a test. The app passes `FetchHttpClient.layer`.
 *
 * `awaitAuthReady` resolves immediately: the shared shape carries it for host
 * apps whose route guards wait on a token that arrives asynchronously, and by
 * the time this runs the handshake is already complete. `web-trace-react` reads
 * only `runAuthed`, but the context has to be a faithful
 * `RouterContextWith<FhirR4ResourcesHttpApiClient>` for its `useRouteContext`
 * select to type.
 *
 * There is no boot-race retry (the host app's `runAuthed` has one for the gap
 * before its `wf_auth` cookie lands). A bearer token is in hand before this is
 * built, so a 401 here is a real 401.
 *
 * @param session - The FHIR base and bearer token from the SMART handshake
 * @param transport - The underlying `HttpClient` every read goes out over
 * @returns A router context ready for `createRouter`'s `context`
 * @throws UnexpectedFhirBase When `session.serverUrl` is not addressable
 */
const buildSmartRouterContext = (
  session: SmartSession,
  transport: Layer.Layer<HttpClient.HttpClient>
): RouterContext => {
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    FhirR4ResourcesRouterContext.sliceRuntimeLayer,
    smartHttpClientLayer(session, transport)
  )
  const runAuthed: RunAuthed = (effect, options) =>
    Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
  return {
    // In-memory only, no persister: a trace body is the rawest data on the
    // device, and this app is the surface that reads it.
    queryClient: new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: pipe(5, Duration.minutes, Duration.toMillis),
          gcTime: pipe(30, Duration.minutes, Duration.toMillis),
          refetchOnWindowFocus: false,
        },
      },
    }),
    runAuthed,
    runtimeLayer,
    awaitAuthReady: () => Promise.resolve(),
  }
}

export {
  apiBaseUrlFromIss,
  buildSmartRouterContext,
  smartHttpClientLayer,
  UnexpectedFhirBase,
  type RouterContext,
  type RunAuthed,
  type RuntimeLayer,
  type SmartSession,
}
