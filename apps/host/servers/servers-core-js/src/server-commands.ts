import type { Effect } from 'effect'
import { Schema } from 'effect'

import type * as CertificateAuthority from './certificate-authority.ts'
import type * as EnteredCredentials from './entered-credentials.ts'
import type * as EnteredRelay from './entered-relay.ts'
import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'
import * as ListedServer from './listed-server.ts'
import type * as RunPolicyChoice from './run-policy-choice.ts'
import * as RunPolicy from './run-policy.ts'

/**
 * Every registered server, in the order they were added, each with its
 * status on the host's unit runner.
 *
 * @remarks
 * Fails with the host's refusal (see `HostCommandFailed.refusal`), kind
 * `registry`, when the host can't read `servers.json`.
 */
const listServers: Effect.Effect<readonly ListedServer.Type[], HostCommandError, TauriInvoke> =
  invokeHostCommand('servers_list', Schema.Array(ListedServer.Schema))

/**
 * Enrol a tunnel at `relay` with `credentials` and register the server,
 * answering with its domain. The host checks before it writes: nothing is
 * registered when it refuses.
 *
 * @remarks
 * A Wildflower relay must serve the identity `relay` pins, if any; then it
 * redeems a claim code, once, for the tunnel's name and token, which the
 * host stores in its place, or it must accept an entered tunnel name and
 * token on a signed `GET /me`. A rathole relay is not asked, and takes no
 * claim code.
 * The host refuses as `invalidRelaySetting`, `relayUnreachable`,
 * `badRelayResponse`, `pinMismatch`, `invalidTunnelName`, `emptyToken`,
 * `emptyClaimCode`, `claimCodesNotOffered`, `claimCodeRejected`,
 * `claimRateLimited`, `signedRequestRejected`, `alreadyRegistered` or
 * `registry`. The new server's run policy is `whileOpen` when no other
 * server's is active, and `off` otherwise. The answer never carries the
 * token.
 */
const addServer = ({
  relay,
  credentials,
}: {
  readonly relay: EnteredRelay.Type
  readonly credentials: EnteredCredentials.Type
}): Effect.Effect<string, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_add', Schema.String, { relay, credentials })

/**
 * Set when the server `domain` runs to `choice`, answering with the run
 * policy the host stored: a `for` choice is stored as `until` its deadline.
 * Every other server keeps its policy.
 */
const setServerRunPolicy = ({
  domain,
  choice,
}: {
  readonly domain: string
  readonly choice: RunPolicyChoice.Type
}): Effect.Effect<RunPolicy.Type, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_set_run_policy', RunPolicy.Schema, { domain, choice })

/**
 * Set the launcher the server `domain` opens apps from, the page its
 * Authorization app opens at, and the ACME CA its certificates are ordered
 * from.
 *
 * @remarks
 * The host refuses a launcher or Authorization URL it can't open a page at as
 * `invalidLauncherUrl` or `invalidAuthorizationUrl`. Its runs read both URLs,
 * so a change to either restarts a running server.
 */
const updateServer = ({
  domain,
  launcherUrl,
  authorizationUrl,
  certificateAuthority,
}: {
  readonly domain: string
  readonly launcherUrl: string
  readonly authorizationUrl: string
  readonly certificateAuthority: CertificateAuthority.Type
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_update', Schema.Null, {
    domain,
    launcherUrl,
    authorizationUrl,
    certificateAuthority,
  })

/**
 * Replace the token the server `domain`'s tunnel signs in to its relay with,
 * once the relay accepts it; the host then starts the server's run again
 * with it.
 *
 * @remarks
 * A Wildflower relay must still present the identity the server was added
 * with, and accept the token on a signed `GET /me`; a rathole server's token
 * is replaced without a request. The answer never carries the token.
 */
const setServerCredentials = ({
  domain,
  token,
}: {
  readonly domain: string
  readonly token: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_set_credentials', Schema.Null, { domain, token })

/**
 * Stop the server `domain` and delete it, with its folder, databases and
 * certificates.
 */
const removeServer = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_remove', Schema.Null, { domain })

/**
 * Open the server `domain`'s launcher, as a SMART EHR launch against it, in
 * the in-app browser, signed in as the server's Owner first: its launcher URL
 * with `iss`, the server's FHIR base, and a `launch` its authorization server
 * minted, which any app may use once. Answers once the browser is opening it,
 * and never changes the server's run policy.
 *
 * @remarks
 * Fails with the host's refusal (see `HostCommandFailed.refusal`), a
 * `LaunchError`: at once, before anything is minted, when the server isn't
 * running, reachable through its relay and holding a valid certificate.
 */
const launchServer = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_launch', Schema.Null, { domain })

/**
 * Open the server `domain`'s Wildflower Authorization app in the in-app
 * browser, signed in as the server's Owner first: its Authorization URL with
 * `iss`, the server's FHIR base. Answers once the browser is opening it, and
 * never changes the server's run policy.
 *
 * @remarks
 * Fails with the host's refusal, a `LaunchError`, for the same reasons
 * {@link launchServer} does.
 */
const openServerAuthorizationApp = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_open_authorization_app', Schema.Null, { domain })

/**
 * Open the newest consent waiting on the server `domain` at its page, in the
 * in-app browser (the default browser on a desktop), signed in as the
 * server's Owner first. The page goes back, or closes, once the Owner has
 * decided. Answers once the browser is opening it.
 *
 * @remarks
 * Fails with the host's refusal, a `LaunchError`: for the same reasons
 * {@link launchServer} does, or `nothingPending` once nothing waits there.
 */
const openPendingConsent = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_open_pending_consent', Schema.Null, { domain })

/**
 * Open the consent the tapped notification `notificationId` announced, as
 * {@link openPendingConsent} opens a server's; a tap on any other
 * notification opens nothing. The host answers at once, and opens it once its
 * server can, logging each try. Only a phone reports taps.
 */
const openNotifiedConsent = ({
  notificationId,
}: {
  readonly notificationId: number
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_open_notified_consent', Schema.Null, { notificationId })

export {
  addServer,
  launchServer,
  listServers,
  openNotifiedConsent,
  openPendingConsent,
  openServerAuthorizationApp,
  removeServer,
  setServerCredentials,
  setServerRunPolicy,
  updateServer,
}
