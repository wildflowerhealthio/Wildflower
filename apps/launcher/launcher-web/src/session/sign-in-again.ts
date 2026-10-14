import { type AuthState, Unauthed } from '@wildflowerhealthio/react-kitchen-sink'

import { RETURN_TO_PARAM } from '../sign-in.ts'

/** Where {@link signInAgain} sends the reader: the landing, carrying where they were. */
interface LandingTarget {
  readonly to: '/'
  readonly search: { readonly [RETURN_TO_PARAM]: string }
}

/**
 * Send the reader back through the SMART sign-in to the session's server, to
 * land on `returnTo` once it redeems.
 *
 * The session goes `Unauthed`, which drops the bearer and keeps its server,
 * and the reader goes to the landing with `?returnTo=`, where token expiry and
 * the `_auth` gate send them too. The landing signs in to the session's server
 * on arrival (`sign-in.ts`'s `startSignIn`, as this app's own client),
 * `returnTo` rides the pending record, and a sign-in that cannot start shows
 * its reason beside a "Sign in to …" for that server. `Unauthed` goes first:
 * the landing sends a signed-in reader on to `/home`.
 */
const signInAgain = (
  setAuthState: (signal: AuthState) => void,
  navigate: (target: LandingTarget) => Promise<void>,
  returnTo: string
): void => {
  setAuthState(Unauthed())
  void navigate({ to: '/', search: { [RETURN_TO_PARAM]: returnTo } })
}

export { signInAgain }
export type { LandingTarget }
