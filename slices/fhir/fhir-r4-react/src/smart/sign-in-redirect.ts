import {
  beginSignIn,
  beginSignInAt,
  createState,
  type PendingRequestUnusable,
  type PkceUnavailable,
  type SignInError,
  type SmartIssuer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect } from 'effect'

import {
  retainSelfAddressedSignInRequest,
  signInEnvironmentFor,
  type SmartRegistration,
} from './retained-sign-in-requests.ts'
import type { FhirBaseUrl } from './smart-connection.ts'

/**
 * Configuration for a SMART App Launch: the app's registration, where the
 * authorization server sends the browser back to, and the FHIR server to sign
 * in to.
 */
interface SmartLaunchConfig extends SmartRegistration {
  readonly redirectUri: string
  /** The FHIR server base to sign in to: an EHR launch's `iss`, or a picked server. */
  readonly fhirBaseUrl: FhirBaseUrl
}

/** Run `beginning`, then send the browser to the authorization URL it yields. */
const redirectToAuthorization = <E>(beginning: Effect.Effect<string, E>): Effect.Effect<void, E> =>
  Effect.flatMap(beginning, (authorizeUrl) =>
    Effect.sync(() => {
      window.location.assign(authorizeUrl)
    })
  )

/**
 * Sign in to `config.fhirBaseUrl`: discover its endpoints, retain what the
 * return needs, and send the browser to the authorization endpoint. `launch`
 * is the EHR's launch token for an EHR launch, and `undefined` for a
 * standalone launch.
 *
 * @remarks
 * `authorization-core`'s `beginSignIn` discovers the endpoints from
 * `{fhirBaseUrl}/.well-known/smart-configuration` and accepts the authorization
 * endpoint only when `endpointUrlFrom` does for this page: a `javascript:`
 * URL, one carrying userinfo or a fragment, and plain http off loopback from an
 * https page are each refused. Then it fails with discovery's reason and the
 * page stays where it is.
 */
const redirectToSignIn = (
  config: SmartLaunchConfig,
  launch: string | undefined
): Effect.Effect<void, SignInError> =>
  redirectToAuthorization(
    beginSignIn(config.fhirBaseUrl, undefined, signInEnvironmentFor(config), {
      launch,
    })
  )

/**
 * Sign in at the already-`discovered` SMART server, as {@link redirectToSignIn}
 * does once it has discovered one: the probe that discovered it is the one
 * fetch of its SMART configuration.
 */
const redirectToSignInAt = (
  discovered: SmartIssuer,
  config: Omit<SmartLaunchConfig, 'fhirBaseUrl'>
): Effect.Effect<void, PkceUnavailable | PendingRequestUnusable> =>
  redirectToAuthorization(beginSignInAt(discovered, undefined, signInEnvironmentFor(config)))

/**
 * Configuration for a self-addressed sign-in to an **open** FHIR server — one
 * whose `.well-known/smart-configuration` names no authorization endpoint (or
 * serves no config at all).
 */
interface SelfAddressedSignInConfig {
  /** The FHIR server base to connect to, used with no `Authorization` header. */
  readonly fhirBaseUrl: FhirBaseUrl
  /** The app root the sign-in is addressed to. */
  readonly redirectUri: string
}

/**
 * Sign in to an open server by addressing the redirect to this page.
 *
 * @remarks
 * An open server has no authorization server, so the page signs in by
 * addressing the redirect to itself: it keeps the server and an
 * `expectedState` under `RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY`,
 * then redirects straight back here. On return the `state` must match, so a
 * link someone else crafted cannot make the app connect to a server they
 * chose.
 */
const redirectToSelfAddressedSignInReturn = (
  config: SelfAddressedSignInConfig
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.gen(function* () {
    const expectedState = createState(window.crypto)
    yield* retainSelfAddressedSignInRequest({ expectedState, fhirBaseUrl: config.fhirBaseUrl })
    const redirectTarget = new URL(config.redirectUri)
    redirectTarget.searchParams.set('state', expectedState)
    window.location.assign(redirectTarget.href)
  })

export {
  redirectToSelfAddressedSignInReturn,
  redirectToSignIn,
  redirectToSignInAt,
  type SelfAddressedSignInConfig,
  type SmartLaunchConfig,
}
