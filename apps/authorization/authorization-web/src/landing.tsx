import { insecureTargetReason } from '@wildflowerhealthio/authorization-core/smart-client'
import { AppLandingPage } from '@wildflowerhealthio/branding-react'
import { withLocalNetworkAccessHint } from '@wildflowerhealthio/fhir-r4-react/smart'
import { ConnectMenu } from '@wildflowerhealthio/smart-app-react'
import type { JSX, ReactNode } from 'react'

import type { SignInProblem, SignInStep } from './sign-in.ts'

/** How the landing starts a sign-in and leaves for it — injected by tests. */
interface LandingSignIn {
  /** Begin a SMART standalone launch against `serverUrl`, yielding the authorization URL. */
  readonly start: (serverUrl: string) => Promise<SignInStep<string>>
  /** Point the page's `?iss=` at `serverUrl`, without reloading. */
  readonly rememberServer: (serverUrl: string) => void
  /** Leave for the authorization server at `authorizationUrl`. */
  readonly leave: (authorizationUrl: string) => void
}

interface LandingProps {
  /** The server `?iss=` named on arrival, in canonical form. */
  readonly arrivalServerUrl: string | undefined
  /**
   * Why a sign-in failed on its way back, before this page loaded, and the
   * server it was to. Shown until a fresh attempt starts; while it shows, the
   * page does not sign in on arrival, which would loop the reader through the
   * authorization server.
   */
  readonly bootSignInProblem: SignInProblem | undefined
  /** Whether the page is served over https, which can't reach a plaintext server. */
  readonly pageIsSecure: boolean
  readonly signIn: LandingSignIn
  /** Rendered above the footer: the telemetry status control. */
  readonly aboveFooter?: ReactNode
}

/**
 * Whether the landing signs in as soon as it opens: `?iss=` names a server
 * this page can reach, and no sign-in to it has just failed.
 */
const shouldSignInOnArrival = (arrival: {
  readonly hasChosenServer: boolean
  readonly blockedReason: string | undefined
  readonly bootSignInProblem: string | undefined
}): boolean =>
  arrival.hasChosenServer &&
  arrival.blockedReason === undefined &&
  arrival.bootSignInProblem === undefined

/**
 * The signed-out page, in the shared Wildflower chrome: the Wildflower
 * Authorization introduction beside the shared `ConnectMenu`, whose presets, a
 * typed address and recent servers pick the server to manage. A pick points
 * `?iss=` at the server and signs in to it. Opened with `?iss=` (a server's
 * `management_endpoint`, the launcher's Manage access row, or a bookmark), it
 * signs in to that server straight away.
 *
 * A server that isn't a Wildflower server is refused before the reader leaves
 * (`sign-in.ts`'s `startSignIn`), and the menu shows why beside where the
 * sign-in started.
 */
function Landing({
  arrivalServerUrl,
  bootSignInProblem,
  pageIsSecure,
  signIn,
  aboveFooter,
}: LandingProps): JSX.Element {
  const chosenServer =
    arrivalServerUrl === undefined
      ? undefined
      : {
          url: arrivalServerUrl,
          blockedReason: insecureTargetReason(arrivalServerUrl, { pageIsSecure }),
        }

  /**
   * The menu's `connect`, for a pick and for the chosen server alike: point
   * `?iss=` at the server and leave for its authorization endpoint. Resolves to
   * the problem to show if the sign-in could not start, or `undefined` once the
   * page is leaving.
   */
  const connect = (serverUrl: string): Promise<string | undefined> => {
    signIn.rememberServer(serverUrl)
    return signIn.start(serverUrl).then((started) => {
      if (started.tag === 'Failed') return started.reason
      signIn.leave(started.value)
      return undefined
    })
  }

  /**
   * `problem`'s reason, followed by the Local Network Access hint when the
   * server the failed sign-in was to is a loopback one and this page is
   * secure.
   */
  const arrivalProblemFor = (problem: SignInProblem): string =>
    problem.serverUrl === undefined
      ? problem.reason
      : withLocalNetworkAccessHint(problem.reason, problem.serverUrl, { pageIsSecure })

  return (
    <AppLandingPage app="authorization" aboveFooter={aboveFooter}>
      <ConnectMenu
        target="wildflower"
        connect={connect}
        arrivalProblem={
          bootSignInProblem === undefined ? undefined : arrivalProblemFor(bootSignInProblem)
        }
        chosenServer={chosenServer}
        // Read once, when the menu mounts: a pick's `?iss=` must not make
        // the page look newly arrived and start a second sign-in.
        autoConnect={shouldSignInOnArrival({
          hasChosenServer: chosenServer !== undefined,
          blockedReason: chosenServer?.blockedReason,
          bootSignInProblem: bootSignInProblem?.reason,
        })}
      />
    </AppLandingPage>
  )
}

export { Landing }
export type { LandingProps, LandingSignIn }
