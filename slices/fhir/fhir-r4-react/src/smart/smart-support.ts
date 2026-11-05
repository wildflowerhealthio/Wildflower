import {
  insecureTargetReason,
  normalizeServerUrl,
  type PendingRequestUnusable,
  type PkceUnavailable,
  smartIssuerFrom,
  type SmartIssuer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import { Data, Effect, Either, Match, Schema } from 'effect'

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
 * Four outcomes. A CORS-blocked probe rejects identically to a down server —
 * the browser gives no way to tell them apart — so a rejected probe is
 * `Unreachable`, surfaced to the user, **never** silently treated as `Open`.
 * Treating it as open would fire unauthenticated resource reads at a server
 * that may well require auth, producing misleading 401s. A real HTTP answer
 * (even a 404, or non-JSON) is `Open`: the server responded, it just has no
 * SMART config. A config that names an `authorization_endpoint` is `Smart`,
 * carrying what `authorization-core`'s `smartIssuerFrom` `discovered` in it,
 * when `smartIssuerFrom` accepts it for this page, and `Unusable`, with its
 * `DiscoveryFailed` reason, when it does not (an endpoint that is not https
 * or loopback, a missing `token_endpoint`, no S256).
 */
type SmartSupport = Data.TaggedEnum<{
  /** A config whose endpoints are usable from this page. */
  readonly Smart: { readonly discovered: SmartIssuer }
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
 * Every outcome is a {@link SmartSupport}, so the Effect never fails.
 * `fetchFn` is a parameter (default `globalThis.fetch`) so a test can drive the
 * outcomes over a stub without a real wire — the same transport-is-a-parameter
 * philosophy as the SMART runtime's `HttpClient`. `pageIsSecure` (default: read
 * from `window.location`) is what decides whether a plain-http endpoint off
 * loopback is `Unusable`.
 *
 * @param fhirBaseUrl - The FHIR server base the well-known path is appended to
 * @param fetchFn - The `fetch` to probe with; defaults to `globalThis.fetch`
 * @param pageIsSecure - Whether this page is served over https
 */
const detectSmartSupport = (
  fhirBaseUrl: FhirBaseUrl,
  fetchFn: typeof fetch = globalThis.fetch,
  pageIsSecure: boolean = window.location.protocol === 'https:'
): Effect.Effect<SmartSupport> =>
  Effect.gen(function* () {
    // A rejected fetch is network-or-CORS and the two are indistinguishable
    // here — surface it, never degrade to `Open`.
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchFn(`${fhirBaseUrl}/.well-known/smart-configuration`, {
          headers: { Accept: 'application/json' },
        }),
      catch: (error) => SmartSupport.Unreachable({ reason: unknownErrorToString(error) }),
    })
    // A real HTTP answer that isn't ok (404, 500, …) is a server with no SMART
    // config → Open. Only a config that names an authorization endpoint is
    // SMART, and only when its endpoints are usable from this page.
    if (!response.ok) return SmartSupport.Open()
    const config = yield* Effect.tryPromise((): Promise<unknown> => response.json()).pipe(
      // Checked, not narrowed: `smartIssuerFrom` reads the whole configuration.
      Effect.tap(decodeSmartConfiguration),
      Effect.mapError(() => SmartSupport.Open())
    )
    return Either.match(smartIssuerFrom(fhirBaseUrl, config, { pageIsSecure }), {
      onLeft: (failed) => SmartSupport.Unusable({ reason: failed.reason }),
      onRight: (discovered) => SmartSupport.Smart({ discovered }),
    })
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
 * for the caller to show.
 *
 * @param config - The server plus the app's client id, scope, and redirect
 *   target
 * @param launch - The EHR's launch token, `undefined` for a standalone launch
 * @param fetchFn - The `fetch` the probe uses; defaults to `globalThis.fetch`
 * @returns The probe outcome. `Smart`/`Open` are returned only in the (unusual)
 *   case the redirect does not navigate the page away; `Unreachable` and
 *   `Unusable` always are.
 */
const redirectToSignIn = (
  config: SmartLaunchConfig,
  launch: string | undefined,
  fetchFn: typeof fetch = globalThis.fetch
): Effect.Effect<SmartSupport, PkceUnavailable | PendingRequestUnusable> =>
  detectSmartSupport(config.fhirBaseUrl, fetchFn).pipe(
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
