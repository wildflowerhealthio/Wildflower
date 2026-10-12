import type { StatusTone } from '@wildflowerhealthio/react-tundraish'
import {
  type HealthReport,
  type ListedServer,
  ServerStatus,
} from '@wildflowerhealthio/servers-core-js'
import { DateTime, Match, Option } from 'effect'

/** How the base shows an instant, in the device's locale and time zone. */
const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** An instant as the base shows it. */
const formatInstant = (instant: DateTime.Utc): string =>
  INSTANT_FORMAT.format(DateTime.toDate(instant))

/**
 * A server's status as the base shows it: the tone of its dot, badge and
 * run-policy field, and its words.
 */
interface StatusSummary {
  readonly tone: StatusTone
  readonly label: string
}

/** The status of a running server that answered `/health`, by the status it answered with. */
const REACHABLE_STATUS: Readonly<Record<HealthReport.Status, StatusSummary>> = {
  pass: { tone: 'success', label: 'Running' },
  warn: { tone: 'warning', label: 'Running, degraded' },
  fail: { tone: 'danger', label: 'Running, failing its health checks' },
}

/** The status of a running server, by its health. */
const runningStatus = (health: ServerStatus.Health): StatusSummary =>
  health.kind === 'reachable'
    ? REACHABLE_STATUS[health.status]
    : { tone: 'warning', label: 'Running, not reachable yet' }

/**
 * The status of a running server by its tunnel's state, when that says more
 * than its health: the relay refused the tunnel, or the tunnel is dialing it
 * again. None while the tunnel is connecting or connected, which its health
 * says.
 */
const tunnelStatus = (tunnel: ServerStatus.TunnelState): Option.Option<StatusSummary> =>
  Match.value(tunnel).pipe(
    Match.withReturnType<Option.Option<StatusSummary>>(),
    Match.when({ kind: 'tokenRejected' }, () =>
      Option.some({ tone: 'danger', label: "The relay rejected this server's tunnel token" })
    ),
    Match.when({ kind: 'tunnelUnknown' }, () =>
      Option.some({ tone: 'danger', label: 'The relay has no tunnel for this server' })
    ),
    Match.when({ kind: 'reconnecting' }, () =>
      Option.some({ tone: 'warning', label: 'Running, reconnecting to the relay' })
    ),
    Match.when({ kind: Match.is('connecting', 'connected') }, () => Option.none()),
    Match.exhaustive
  )

/** The tunnel's state of the server whose status is `status`, while it runs. */
const runningTunnelOf = (status: ServerStatus.Type): Option.Option<ServerStatus.TunnelState> =>
  status.runState === 'running' ? ServerStatus.tunnelOf(status) : Option.none()

/**
 * The status, merged from the run state, the tunnel's state and the health:
 * a running server is a success only once it answers `/health`, one whose
 * relay refused its tunnel is in danger, and so is a stopped server whose
 * latest run failed.
 *
 * @remarks
 * A refused or reconnecting tunnel takes priority over the health: the host
 * checks the health only until it first answers, so a reachable health may
 * predate it.
 */
const statusSummary = (status: ServerStatus.Type): StatusSummary => {
  if (status.runState === 'starting') return { tone: 'info', label: 'Starting' }
  if (status.runState === 'running') {
    return runningTunnelOf(status).pipe(
      Option.flatMap(tunnelStatus),
      Option.orElse(() => ServerStatus.healthOf(status).pipe(Option.map(runningStatus))),
      Option.getOrElse((): StatusSummary => ({
        tone: 'info',
        label: 'Running, checking it can be reached',
      }))
    )
  }
  const failed = ServerStatus.lastStopOf(status).pipe(
    Option.exists((stop) => Option.isSome(stop.error))
  )
  return { tone: failed ? 'danger' : 'neutral', label: 'Stopped' }
}

/**
 * What a relay's refusal of a server's tunnel, named `tunnelName`, says
 * beyond its status, and what to do about it, by the refusal.
 */
const tunnelRefusalNote = (
  refusal: 'tokenRejected' | 'tunnelUnknown',
  tunnelName: string
): string =>
  refusal === 'tokenRejected'
    ? "Enter a new token on the Relay tab of the server's page."
    : `The tunnel ${tunnelName} may have been deleted. Check the tunnel name, or ask whoever runs the relay.`

/**
 * What `server`'s status says beyond the run state: what to do about a
 * relay's refusal of its tunnel, why its tunnel is reconnecting, or the
 * host's reason a running server isn't reachable when it has one; nothing
 * for a server that is plainly running or stopped, which the dot says alone.
 */
const statusNote = (server: ListedServer.Type): Option.Option<string> => {
  const { status } = server
  if (status.runState === 'stopped') return Option.none()
  const { label } = statusSummary(status)
  const tunnel = Option.getOrNull(runningTunnelOf(status))
  if (tunnel?.kind === 'reconnecting') return Option.some(`${label}: ${tunnel.error}`)
  if (tunnel?.kind === 'tokenRejected' || tunnel?.kind === 'tunnelUnknown') {
    return Option.some(`${label}. ${tunnelRefusalNote(tunnel.kind, server.tunnelName)}`)
  }
  const health = Option.getOrNull(ServerStatus.healthOf(status))
  if (health?.kind === 'reachable' && health.status === 'pass') return Option.none()
  return Option.some(health?.kind === 'unreachable' ? `${label}: ${health.error}` : label)
}

/** Why a run stopped, as a sentence, for every reason but a failure. */
const STOP_REASON_TEXT: Readonly<
  Record<Exclude<ServerStatus.RunStop['reason'], 'endedOnItsOwn'>, string>
> = {
  policyInactive: 'It stopped as its run policy ended.',
  replaced: 'It stopped to start again with its new settings.',
  removed: 'It was removed.',
  sessionEndedByPlatform: 'The system ended its time in the background.',
  stoppedForRestart: 'It stopped to start again.',
}

/** Why the server's latest run stopped, as a sentence. */
const lastStopText = (stop: ServerStatus.RunStop): string =>
  stop.reason === 'endedOnItsOwn'
    ? stop.error.pipe(
        Option.map((error) => `It stopped with an error: ${error}`),
        Option.getOrElse(() => 'It stopped on its own.')
      )
    : STOP_REASON_TEXT[stop.reason]

/** Why the platform ended the app's background session, as a sentence. */
const PLATFORM_STOP_REASON_TEXT: Readonly<
  Record<typeof ServerStatus.PlatformStopReasonSchema.Type, string>
> = {
  userStop: 'It was stopped from the system.',
  platformTimeout: "The system's time limit for background work ran out.",
  platformExpiration: "The system's background time expired.",
  nativeNotificationStop: 'It was stopped from its notification.',
  osRestart: 'The device restarted.',
  bootRecovery: 'It was recovering after the device started.',
  taskCompleted: 'The system finished its background task.',
  error: 'The background session failed.',
  processExit: 'The app was closed.',
  unknown: 'The system gave no reason.',
}

export {
  formatInstant,
  INSTANT_FORMAT,
  lastStopText,
  PLATFORM_STOP_REASON_TEXT,
  REACHABLE_STATUS,
  runningStatus,
  STOP_REASON_TEXT,
  statusNote,
  statusSummary,
}
export type { StatusSummary }
