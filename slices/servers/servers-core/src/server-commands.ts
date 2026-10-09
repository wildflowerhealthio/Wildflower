import type { Effect } from 'effect'
import { Schema } from 'effect'

import type * as CertificateAuthority from './certificate-authority.ts'
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
 * Enrol the tunnel `tunnelName` at `relay` with `token` and register the
 * server, answering with its domain. The host checks before it writes:
 * nothing is registered when it refuses.
 *
 * @remarks
 * A Wildflower relay must serve the identity `relay` pins, if any, and
 * accept the tunnel name and token on a signed `GET /me`; a rathole relay is
 * not asked. The host refuses as `invalidRelaySetting`, `relayUnreachable`,
 * `badRelayResponse`, `pinMismatch`, `invalidTunnelName`, `emptyToken`,
 * `signedRequestRejected`, `alreadyRegistered` or `registry`. The new
 * server's run policy is `whileOpen` when no other server's is active, and
 * `off` otherwise. The answer never carries the token.
 */
const addServer = ({
  relay,
  tunnelName,
  token,
}: {
  readonly relay: EnteredRelay.Type
  readonly tunnelName: string
  readonly token: string
}): Effect.Effect<string, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_add', Schema.String, { relay, tunnelName, token })

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
 * Set the launcher the server `domain` opens apps from, and the ACME CA its
 * certificates are ordered from.
 */
const updateServer = ({
  domain,
  launcherUrl,
  certificateAuthority,
}: {
  readonly domain: string
  readonly launcherUrl: string
  readonly certificateAuthority: CertificateAuthority.Type
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_update', Schema.Null, { domain, launcherUrl, certificateAuthority })

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

export {
  addServer,
  listServers,
  removeServer,
  setServerCredentials,
  setServerRunPolicy,
  updateServer,
}
