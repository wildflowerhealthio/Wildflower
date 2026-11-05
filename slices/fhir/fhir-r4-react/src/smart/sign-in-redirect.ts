import {
  beginSignInAt,
  createState,
  type RetainedRequestUnusable,
  type PkceUnavailable,
  type RetainedSignInRequestStore,
  SignInCrypto,
  type DiscoveredSmartServer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect } from 'effect'

import {
  type RetainedSelfAddressedSignInRequestStore,
  retainSelfAddressedSignInRequest,
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
const redirectToAuthorization = <E, R>(
  beginning: Effect.Effect<string, E, R>
): Effect.Effect<void, E, R> =>
  Effect.flatMap(beginning, (authorizeUrl) =>
    Effect.sync(() => {
      window.location.assign(authorizeUrl)
    })
  )

/**
 * Sign in at the already-`discovered` SMART server: retain what the return
 * needs, and send the browser to its authorization endpoint. `launch` is the
 * EHR's launch token for an EHR launch, and `undefined` for a standalone
 * launch.
 *
 * It runs on the sign-in services the edge that runs it provides
 * (`smartSignInLayer`), which keep the retained sign-in request at
 * `RETAINED_SIGN_IN_REQUEST_KEY`.
 */
const redirectToSignInAt = (
  discovered: DiscoveredSmartServer,
  config: Omit<SmartLaunchConfig, 'fhirBaseUrl'>,
  launch: string | undefined
): Effect.Effect<
  void,
  PkceUnavailable | RetainedRequestUnusable,
  SignInCrypto | RetainedSignInRequestStore
> => redirectToAuthorization(beginSignInAt(discovered, config, { launch }))

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
 * chose. The `state`'s random bytes come from the `SignInCrypto`, and the
 * request is kept in the `RetainedSelfAddressedSignInRequestStore`.
 */
const redirectToSelfAddressedSignInReturn = (
  config: SelfAddressedSignInConfig
): Effect.Effect<
  void,
  RetainedRequestUnusable,
  SignInCrypto | RetainedSelfAddressedSignInRequestStore
> =>
  Effect.gen(function* () {
    const expectedState = createState((yield* SignInCrypto).randomBytes)
    yield* retainSelfAddressedSignInRequest({ expectedState, fhirBaseUrl: config.fhirBaseUrl })
    const redirectTarget = new URL(config.redirectUri)
    redirectTarget.searchParams.set('state', expectedState)
    window.location.assign(redirectTarget.href)
  })

export {
  redirectToSelfAddressedSignInReturn,
  redirectToSignInAt,
  type SelfAddressedSignInConfig,
  type SmartLaunchConfig,
}
