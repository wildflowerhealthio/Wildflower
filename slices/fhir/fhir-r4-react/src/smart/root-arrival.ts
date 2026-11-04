import {
  arrivingSmartLaunchFrom,
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Data, identity, Option, Schema } from 'effect'

import { decodeLaunchError, LAUNCH_ERROR_PARAM, type LaunchErrorBody } from './launch-error.ts'

/**
 * Why a SMART app's root page was opened, read once from its query string,
 * from the most specific arrival to the least.
 *
 * - **SignInReturn** (`?code=`): the authorization server sent a sign-in back
 *   with a code to redeem.
 * - **SelfAddressedSignInReturn** (`?state=` alone): the page's own
 *   self-addressed sign-in to an open server came back (see
 *   `redirectToSelfAddressedSignInReturn`).
 * - **SignInRefused** (`?error=`): the authorization server refused the
 *   sign-in.
 * - **LaunchRequest** (`?iss=`): a launch to start, an EHR's or a standalone
 *   link's.
 * - **Visit**: a bare visit, or a failed launch sent back here with our own
 *   `?launchError=`.
 */
type RootArrival = Data.TaggedEnum<{
  readonly SignInReturn: { readonly code: string; readonly state: string }
  readonly SelfAddressedSignInReturn: { readonly state: string }
  readonly SignInRefused: { readonly refusal: LaunchErrorBody }
  readonly LaunchRequest: { readonly launch: ArrivingSmartLaunch }
  readonly Visit: { readonly launchError: Option.Option<LaunchErrorBody> }
}>
const RootArrival = Data.taggedEnum<RootArrival>()

/** An arrival that carries a sign-in for the app to complete. */
type SignInArrival = Data.TaggedEnum.Value<
  RootArrival,
  'SignInReturn' | 'SelfAddressedSignInReturn'
>

/** An optional text field that reads an empty string as absent. */
const OptionalText = Schema.optionalToOptional(Schema.String, Schema.String, {
  decode: Option.filter((text) => text !== ''),
  encode: identity,
})

/**
 * The OAuth-standard error return (RFC 6749 §4.1.2.1) the authorization server
 * appends to the redirect URI.
 */
const OAuthErrorReturn = Schema.Struct({
  error: Schema.NonEmptyString,
  error_description: OptionalText,
  error_uri: OptionalText,
})
const decodeOAuthErrorReturn = Schema.decodeUnknownOption(OAuthErrorReturn)

/** A sign-in's return: its code, and the `state` it carries (empty when it carries none). */
const SignInReturnParameters = Schema.Struct({
  code: Schema.NonEmptyString,
  state: Schema.optionalWith(Schema.String, { default: () => '' }),
})
const decodeSignInReturn = Schema.decodeUnknownOption(SignInReturnParameters)

/** A self-addressed sign-in's return: its `state`, with no code. */
const SelfAddressedSignInReturnParameters = Schema.Struct({ state: Schema.String })
const decodeSelfAddressedSignInReturn = Schema.decodeUnknownOption(
  SelfAddressedSignInReturnParameters
)

/**
 * What a `?launchError=` that does not decode (a hand-edited or truncated
 * URL) reads as: a launch failure with no tag, which the banner shows as
 * its fallback sentence.
 */
const UNREADABLE_LAUNCH_ERROR: LaunchErrorBody = { error: '' }

/** The launch failure a visit's `?launchError=` carries, if it carries one. */
const launchErrorOf = (parameters: URLSearchParams): Option.Option<LaunchErrorBody> =>
  Option.fromNullable(parameters.get(LAUNCH_ERROR_PARAM)).pipe(
    Option.filter((encoded) => encoded !== ''),
    Option.map((encoded) =>
      Option.getOrElse(decodeLaunchError(encoded), () => UNREADABLE_LAUNCH_ERROR)
    )
  )

/**
 * The {@link RootArrival} `search` is.
 *
 * @remarks
 * The authorization server's refusal is read before its code: an `?error=`
 * return carries `state` too, and a refused sign-in has nothing to redeem. A
 * `?code=` with no `state` is still a sign-in's return, and its redemption
 * refuses it, since no retained sign-in request has an empty `state`. Any
 * authorization-response parameter left over rules out a launch request
 * (`arrivingSmartLaunchFrom`), so a return is never mistaken for one.
 */
const rootArrivalFrom = (search: string): RootArrival => {
  const parameters = new URLSearchParams(search)
  const fields = Object.fromEntries(parameters)
  return decodeOAuthErrorReturn(fields).pipe(
    Option.map(
      (refusal): RootArrival =>
        RootArrival.SignInRefused({
          refusal: {
            error: 'AuthorizationDenied',
            message: refusal.error,
            description: refusal.error_description,
            uri: refusal.error_uri,
          },
        })
    ),
    Option.orElse(() =>
      Option.map(decodeSignInReturn(fields), (signInReturn) =>
        RootArrival.SignInReturn(signInReturn)
      )
    ),
    Option.orElse(() =>
      Option.map(decodeSelfAddressedSignInReturn(fields), (selfAddressedReturn) =>
        RootArrival.SelfAddressedSignInReturn(selfAddressedReturn)
      )
    ),
    Option.orElse(() =>
      Option.map(arrivingSmartLaunchFrom(search), (launch) => RootArrival.LaunchRequest({ launch }))
    ),
    Option.getOrElse(() => RootArrival.Visit({ launchError: launchErrorOf(parameters) }))
  )
}

export {
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * the launch a page's URL asks it to start, which {@link rootArrivalFrom}
   * reads as a `LaunchRequest`. The pages that sign in with
   * `authorization-core` read launches the same way without depending on this
   * package.
   */
  arrivingSmartLaunchFrom,
  RootArrival,
  rootArrivalFrom,
  /** Re-exported with `arrivingSmartLaunchFrom`: the parameters it reads a launch from. */
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type SignInArrival,
}
