import {
  insecureTargetReason,
  normalizeServerUrl,
  type PendingRequestUnusable,
  type PkceUnavailable,
  smartIssuerFrom,
  type SmartIssuer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import { Effect, Either, Match, Schema } from 'effect'

import {
  authorizeOpenServer,
  authorizeSmartLaunchAt,
  type SmartLaunchConfig,
} from './smart-launch.ts'
import type { FhirBaseUrl } from './smart-connection.ts'

/**
 * What probing a FHIR server's `.well-known/smart-configuration` told us about
 * how to connect to it.
 *
 * @remarks
 * Four outcomes. A CORS-blocked probe rejects identically to a down server —
 * the browser gives no way to tell them apart — so a rejected probe is
 * `unreachable`, surfaced to the user, **never** silently treated as `open`.
 * Treating it as open would fire unauthenticated resource reads at a server
 * that may well require auth, producing misleading 401s. A real HTTP answer
 * (even a 404, or non-JSON) is `open`: the server responded, it just has no
 * SMART config. A config that names an `authorization_endpoint` is `smart`,
 * carrying the issuer `authorization-core`'s `smartIssuerFrom` reads from it,
 * when `smartIssuerFrom` accepts it for this page, and
 * `unusable`, with its `DiscoveryFailed` reason, when it does not (an endpoint
 * that is not https or loopback, a missing `token_endpoint`, no S256).
 */
type SmartSupport =
  | { readonly kind: 'smart'; readonly issuer: SmartIssuer } // config found, its endpoints usable from this page
  | { readonly kind: 'open' } // HTTP non-ok, or JSON without authorization_endpoint
  | { readonly kind: 'unreachable'; readonly message: string } // fetch rejected (network/CORS — indistinguishable)
  | { readonly kind: 'unusable'; readonly reason: string } // config names endpoints this page will not use

/**
 * A configuration that names an `authorization_endpoint` — the one field that
 * distinguishes a SMART server from an open one. Anything else (no such key,
 * or a value that is not a string) is an open server as far as the standalone
 * flow is concerned.
 */
const NamesAuthorizationEndpoint = Schema.Struct({ authorization_endpoint: Schema.String })

/** Whether a configuration is one a SMART server serves: JSON that names an `authorization_endpoint`. */
const decodeSmartConfiguration = Schema.decodeUnknown(NamesAuthorizationEndpoint)

/**
 * Probe `{iss}/.well-known/smart-configuration` to decide how to connect.
 *
 * @remarks
 * Every outcome is a {@link SmartSupport}, so the Effect never fails.
 * `fetchFn` is a parameter (default `globalThis.fetch`) so a test can drive the
 * outcomes over a stub without a real wire — the same transport-is-a-parameter
 * philosophy as the SMART runtime's `HttpClient`. `pageIsSecure` (default: read
 * from `window.location`) is what decides whether a plain-http endpoint off
 * loopback is `unusable`.
 *
 * @param iss - The FHIR server base the well-known path is appended to
 * @param fetchFn - The `fetch` to probe with; defaults to `globalThis.fetch`
 * @param pageIsSecure - Whether this page is served over https
 */
const detectSmartSupport = (
  iss: FhirBaseUrl,
  fetchFn: typeof fetch = globalThis.fetch,
  pageIsSecure: boolean = window.location.protocol === 'https:'
): Effect.Effect<SmartSupport> =>
  Effect.gen(function* () {
    // A rejected fetch is network-or-CORS and the two are indistinguishable
    // here — surface it, never degrade to `open`.
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchFn(`${iss}/.well-known/smart-configuration`, {
          headers: { Accept: 'application/json' },
        }),
      catch: (error): SmartSupport => ({ kind: 'unreachable', message: unknownErrorToString(error) }),
    })
    // A real HTTP answer that isn't ok (404, 500, …) is a server with no SMART
    // config → open. Only a config that names an authorization endpoint is
    // SMART, and only when its endpoints are usable from this page.
    if (!response.ok) return { kind: 'open' }
    const config = yield* Effect.tryPromise((): Promise<unknown> => response.json()).pipe(
      // Checked, not narrowed: `smartIssuerFrom` reads the whole configuration.
      Effect.tap(decodeSmartConfiguration),
      Effect.mapError((): SmartSupport => ({ kind: 'open' }))
    )
    return Either.match(smartIssuerFrom(iss, config, { pageIsSecure }), {
      onLeft: (failed): SmartSupport => ({ kind: 'unusable', reason: failed.reason }),
      onRight: (issuer): SmartSupport => ({ kind: 'smart', issuer }),
    })
  }).pipe(Effect.merge)

/**
 * Run a standalone SMART App Launch against `config.iss`: probe, then take the
 * SMART OAuth path, the open (no-auth) path, or neither.
 *
 * @remarks
 * On `smart`/`open` the browser redirects away (`authorizeSmartLaunchAt` sends
 * it to the provider, `authorizeOpenServer` straight to the redirect target),
 * so the page usually leaves. The sign-in starts at the issuer the probe
 * found, so the server's SMART configuration is fetched once. A failure of
 * either (a storage that will not keep the pending record) is this Effect's.
 * On `unreachable` or `unusable` there is no redirect — the `SmartSupport` is
 * the result, so the caller can render the error and offer a retry.
 *
 * @param config - The picked server plus the app's client id, scope, and
 *   redirect target
 * @param fetchFn - The `fetch` the probe uses; defaults to `globalThis.fetch`
 * @returns The probe outcome. `smart`/`open` are returned only in the (unusual)
 *   case the redirect does not navigate the page away; `unreachable` and
 *   `unusable` always are.
 */
const startStandaloneLaunch = (
  config: SmartLaunchConfig,
  fetchFn: typeof fetch = globalThis.fetch
): Effect.Effect<SmartSupport, PkceUnavailable | PendingRequestUnusable> =>
  detectSmartSupport(config.iss, fetchFn).pipe(
    Effect.tap((support) =>
      Match.value(support).pipe(
        Match.when({ kind: 'smart' }, ({ issuer }) => authorizeSmartLaunchAt(issuer, config)),
        Match.when({ kind: 'open' }, () =>
          authorizeOpenServer({ fhirServiceUrl: config.iss, redirectUri: config.redirectUri })
        ),
        // `unreachable` and `unusable` have no redirect — the caller renders them.
        Match.orElse(() => Effect.void)
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
   * implementation. This module used to carry a byte-identical copy, because the
   * original lived in `apps/server-docs-web` and a slice cannot import
   * from an app. Moving it into `authorization-core` removed that obstacle, so the
   * copy is gone and `connect-menu.tsx` and the apps now canonicalise a picked
   * FHIR server base exactly as the docs console canonicalises `?server=`.
   */
  normalizeServerUrl,
  startStandaloneLaunch,
  type SmartSupport,
}
