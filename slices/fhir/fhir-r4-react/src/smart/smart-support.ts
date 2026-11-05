import type { HttpClient } from '@effect/platform'
import {
  insecureTargetReason,
  normalizeServerUrl,
  type RetainedRequestUnusable,
  type PkceUnavailable,
  SignInPage,
  signInHttpClient,
  discoveredSmartServerFrom,
  type DiscoveredSmartServer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import { Data, Effect, Either, Match, Schema } from 'effect'

import type { SmartSignInServices } from './retained-sign-in-requests.ts'
import {
  redirectToSelfAddressedSignInReturn,
  redirectToSignInAt,
  type SmartLaunchConfig,
} from './sign-in-redirect.ts'
import type { FhirBaseUrl } from './smart-connection.ts'

/**
 * What probing a FHIR server's `.well-known/smart-configuration` told us about
 * how to sign in to it.
 *
 * @remarks
 * Four outcomes. A CORS-blocked probe gets no response, as a down server's
 * does — the browser gives no way to tell them apart — so a probe with no
 * response is
 * `Unreachable`, surfaced to the user, **never** silently treated as `Open`.
 * Treating it as open would fire unauthenticated resource reads at a server
 * that may well require auth, producing misleading 401s. A real HTTP answer
 * (even a 404, or non-JSON) is `Open`: the server responded, it just has no
 * SMART config. A config that names an `authorization_endpoint` is `Smart`,
 * carrying what `authorization-core`'s `discoveredSmartServerFrom`
 * `discovered` in it, when `discoveredSmartServerFrom` accepts it for this
 * page, and `Unusable`, with its
 * `DiscoveryFailed` reason, when it does not (an endpoint that is not https
 * or loopback, a missing `token_endpoint`, no S256).
 */
type SmartSupport = Data.TaggedEnum<{
  /** A config whose endpoints are usable from this page. */
  readonly Smart: { readonly discovered: DiscoveredSmartServer }
  /** An HTTP answer that is not ok, or JSON without an `authorization_endpoint`. */
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Open: Record<never, never>
  /** The probe was refused: the network, or CORS, which look the same. */
  readonly Unreachable: { readonly reason: string }
  /** A config naming endpoints this page will not use. */
  readonly Unusable: { readonly reason: string }
}>
const SmartSupport = Data.taggedEnum<SmartSupport>()

/**
 * A configuration that names an `authorization_endpoint` — the one field that
 * distinguishes a SMART server from an open one. Anything else (no such key,
 * or a value that is not a string) is an open server as far as the standalone
 * flow is concerned.
 */
const NamesAuthorizationEndpoint = Schema.Struct({ authorization_endpoint: Schema.String })

/** Whether a configuration names an `authorization_endpoint`, as a SMART server's does. */
const decodeSmartConfiguration = Schema.decodeUnknown(NamesAuthorizationEndpoint)

/**
 * Probe `{fhirBaseUrl}/.well-known/smart-configuration` to decide how to sign in.
 *
 * @remarks
 * Every outcome is a {@link SmartSupport}, so the Effect never fails. The
 * probe goes through `authorization-core`'s `signInHttpClient`, the context's
 * `HttpClient` sending no trace headers, so the request stays a CORS-simple
 * one, and the `SignInPage` decides whether a
 * plain-http endpoint off loopback is `Unusable`.
 *
 * @param fhirBaseUrl - The FHIR server base the well-known path is appended to
 */
const detectSmartSupport = (
  fhirBaseUrl: FhirBaseUrl
): Effect.Effect<SmartSupport, never, HttpClient.HttpClient | SignInPage> =>
  Effect.gen(function* () {
    const client = yield* signInHttpClient
    const page = yield* SignInPage
    // A request that gets no response is network-or-CORS and the two are
    // indistinguishable here — surface it, never degrade to `Open`.
    const response = yield* client
      .get(`${fhirBaseUrl}/.well-known/smart-configuration`, { acceptJson: true })
      .pipe(
        Effect.mapError((error) =>
          SmartSupport.Unreachable({ reason: unknownErrorToString(error.cause) })
        )
      )
    // A real HTTP answer that isn't ok (404, 500, …) is a server with no SMART
    // config → Open. Only a config that names an authorization endpoint is
    // SMART, and only when its endpoints are usable from this page.
    if (response.status < 200 || response.status >= 300) return SmartSupport.Open()
    const config = yield* response.json.pipe(
      // Checked, not narrowed: `discoveredSmartServerFrom` reads the whole configuration.
      Effect.tap(decodeSmartConfiguration),
      Effect.mapError(() => SmartSupport.Open())
    )
    return Either.match(
      discoveredSmartServerFrom(fhirBaseUrl, config, { pageIsSecure: page.isSecure }),
      {
        onLeft: (failed) => SmartSupport.Unusable({ reason: failed.reason }),
        onRight: (discovered) => SmartSupport.Smart({ discovered }),
      }
    )
  }).pipe(Effect.merge)

/**
 * Sign in to `config.fhirBaseUrl`, a server a reader picked or an EHR launch's
 * `iss`: probe it, then redirect the way its {@link SmartSupport} says, or not
 * at all. `launch` is the EHR's launch token for an EHR launch, and
 * `undefined` for a standalone launch.
 *
 * @remarks
 * A `Smart` server is signed in to at what the probe discovered
 * (`redirectToSignInAt`), so its SMART configuration is fetched once; an
 * `Open` one by a self-addressed sign-in
 * (`redirectToSelfAddressedSignInReturn`), which has no authorization server
 * to send `launch` to. Either redirect usually takes the page away, and a
 * storage that will not retain the sign-in request fails this Effect.
 * `Unreachable` and `Unusable` redirect nowhere: the support is the result,
 * for the caller to show. The caller provides the sign-in services
 * (`smartSignInLayer`).
 *
 * @param config - The server plus the app's client id, scope, and redirect
 *   target
 * @param launch - The EHR's launch token, `undefined` for a standalone launch
 * @returns The probe outcome. `Smart`/`Open` are returned only in the (unusual)
 *   case the redirect does not navigate the page away; `Unreachable` and
 *   `Unusable` always are.
 */
const redirectToSignIn = (
  config: SmartLaunchConfig,
  launch: string | undefined
): Effect.Effect<SmartSupport, PkceUnavailable | RetainedRequestUnusable, SmartSignInServices> =>
  detectSmartSupport(config.fhirBaseUrl).pipe(
    Effect.tap(
      Match.type<SmartSupport>().pipe(
        Match.tag('Smart', ({ discovered }) => redirectToSignInAt(discovered, config, launch)),
        Match.tag('Open', () =>
          redirectToSelfAddressedSignInReturn({
            fhirBaseUrl: config.fhirBaseUrl,
            redirectUri: config.redirectUri,
          })
        ),
        Match.tag('Unreachable', 'Unusable', () => Effect.void),
        Match.exhaustive
      )
    )
  )

export {
  detectSmartSupport,
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * why an https page cannot reach a plain-http, non-loopback server, which
   * `connect-menu.tsx` checks a pick against before it connects.
   */
  insecureTargetReason,
  /**
   * Re-exported from `authorization-core/smart-client`, which owns the one
   * implementation, so `connect-menu.tsx` and the apps canonicalise a picked
   * FHIR server base exactly as the docs console canonicalises `?server=`.
   */
  normalizeServerUrl,
  redirectToSignIn,
  SmartSupport,
}
