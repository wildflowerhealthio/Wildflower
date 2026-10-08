import type { Effect } from 'effect'
import { Schema } from 'effect'

import type * as CertificateAuthority from './certificate-authority.ts'
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
 * Stop the server `domain` and delete it, with its folder, databases and
 * certificates.
 */
const removeServer = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_remove', Schema.Null, { domain })

export { listServers, removeServer, setServerRunPolicy, updateServer }
