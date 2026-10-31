import { type AuthState, Unauthed } from '@wildflowerhealthio/react-kitchen-sink'

import { PROMPT_PARAM, RETURN_TO_PARAM } from '../sign-in.ts'

/**
 * Where {@link signInAgain} sends the reader: the landing, carrying where they
 * were, and, for Request access, `prompt=consent`.
 */
interface LandingTarget {
  readonly to: '/'
  readonly search: {
    readonly [RETURN_TO_PARAM]: string
    readonly [PROMPT_PARAM]?: 'consent'
  }
}

/**
 * Send the reader back through the SMART sign-in to the session's server, to
 * land on `returnTo` once it redeems.
 *
 * The session goes `Unauthed`, which drops the bearer and keeps its server,
 * and the reader goes to the landing with `?returnTo=`, where token expiry and
 * the `_auth` gate send them too. `prompt` set to `consent` (Request access)
 * rides along as `?prompt=consent`, so the server shows its limited page again
 * when this browser's session holds less than the launcher asks for. The landing signs in to the session's server
 * on arrival (`sign-in.ts`'s `startSignIn`, as this app's own client),
 * `returnTo` rides the pending record, and a sign-in that cannot start shows
 * its reason beside a "Sign in to …" for that server. `Unauthed` goes first:
 * the landing sends a signed-in reader on to `/home`.
 */
const signInAgain = (
  setAuthState: (signal: AuthState) => void,
  navigate: (target: LandingTarget) => Promise<void>,
  returnTo: string,
  prompt?: 'consent'
): void => {
  setAuthState(Unauthed())
  const search =
    prompt === undefined
      ? { [RETURN_TO_PARAM]: returnTo }
      : { [RETURN_TO_PARAM]: returnTo, [PROMPT_PARAM]: prompt }
  void navigate({ to: '/', search })
}

export { signInAgain }
export type { LandingTarget }
