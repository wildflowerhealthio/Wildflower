import type { Effect } from 'effect'
import { Schema } from 'effect'

import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * When the user wants a server run, as `servers.json` stores it: never,
 * while the app is in use, until `at`, or always.
 *
 * @remarks
 * An `until` whose `at` has passed stays as it is: the window has ended, and
 * the server doesn't run.
 */
const RunPolicy = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('off') }),
  Schema.Struct({ kind: Schema.Literal('whileInUse') }),
  Schema.Struct({ kind: Schema.Literal('until'), at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal('always') })
)
type RunPolicy = typeof RunPolicy.Type

/**
 * The run policy the user picks: a {@link RunPolicy} with the window given as
 * a number of seconds from now, which the host stores as `until` that moment.
 *
 * @remarks
 * The host refuses `seconds` of zero or less.
 */
const RunPolicyChoice = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('off') }),
  Schema.Struct({ kind: Schema.Literal('whileInUse') }),
  Schema.Struct({ kind: Schema.Literal('for'), seconds: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal('always') })
)
type RunPolicyChoice = typeof RunPolicyChoice.Type

/** Where a server's run is; a stopped run carries the error it stopped with, if any. */
const ServerRunState = Schema.Union(
  Schema.Struct({ state: Schema.Literal('starting') }),
  Schema.Struct({ state: Schema.Literal('running') }),
  Schema.Struct({ state: Schema.Literal('stopped'), error: Schema.NullOr(Schema.String) })
)
type ServerRunState = typeof ServerRunState.Type

/** The fields of a running server's tunnel liveness the base reads. */
const TunnelLiveness = Schema.Struct({
  status: Schema.Literal('off', 'misconfigured', 'dialing', 'verified', 'unreachable'),
  publicHost: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
type TunnelLiveness = typeof TunnelLiveness.Type

/**
 * Where one server's run is, as the host holds it: never stored.
 * `startedAt` is when the current run began serving, `null` unless running.
 */
const ServerStatus = Schema.Struct({
  domain: Schema.String,
  runState: ServerRunState,
  tunnelLiveness: Schema.NullOr(TunnelLiveness),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
})
type ServerStatus = typeof ServerStatus.Type

/** The relay a server's tunnel runs through. */
const RelayKind = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('wildflowerOfficial') }),
  Schema.Struct({ kind: Schema.Literal('selfHostedWildflower'), baseUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('rathole') })
)
type RelayKind = typeof RelayKind.Type

/** One registered server as `servers_list` answers it, with its current status. */
const ListedServer = Schema.Struct({
  domain: Schema.String,
  relay: RelayKind,
  tunnelName: Schema.String,
  launcherUrl: Schema.String,
  stagingCertificates: Schema.Boolean,
  runPolicy: RunPolicy,
  status: ServerStatus,
})
type ListedServer = typeof ListedServer.Type

/**
 * The Tauri event the host emits a server's {@link ServerStatus} on whenever
 * it changes. Decode its payload with {@link decodeServerStatus}.
 */
const SERVER_STATUS_EVENT = 'server-status'

/** Decode a `server-status` event's payload. */
const decodeServerStatus = Schema.decodeUnknown(ServerStatus)

/**
 * Every registered server, in the order they were added, with its current
 * status.
 *
 * @remarks
 * Fails with the host's `{ kind, message }` (see {@link HostCommandError})
 * when the host can't read `servers.json`.
 */
const listServers: Effect.Effect<readonly ListedServer[], HostCommandError, TauriInvoke> =
  invokeHostCommand('servers_list', Schema.Array(ListedServer))

/**
 * Set the run policy of the server with `domain`, answering with the policy
 * the host stored. Any choice but `off` sets every other server `off`.
 */
const setServerRunPolicy = (
  domain: string,
  policy: RunPolicyChoice
): Effect.Effect<RunPolicy, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_set_run_policy', RunPolicy, { domain, policy })

/** Set the launcher the server with `domain` opens apps from, and its certificate source. */
const updateServer = (
  domain: string,
  settings: { readonly launcherUrl: string; readonly stagingCertificates: boolean }
): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_update', Schema.Null, { domain, ...settings })

/** Stop the server with `domain` and delete it, with its folder. */
const removeServer = (domain: string): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_remove', Schema.Null, { domain })

export {
  decodeServerStatus,
  ListedServer,
  listServers,
  RelayKind,
  removeServer,
  RunPolicy,
  RunPolicyChoice,
  SERVER_STATUS_EVENT,
  ServerRunState,
  ServerStatus,
  setServerRunPolicy,
  TunnelLiveness,
  updateServer,
}
