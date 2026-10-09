import { DateTime, Option } from 'effect'
import type { StatusTone } from 'react-tundraish'
import { type HealthReport, ServerStatus } from 'servers-core'

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
 * The status, merged from the run state and the health: a running server is
 * a success only once it answers `/health`, and a stopped server whose
 * latest run failed is in danger.
 */
const statusSummary = (status: ServerStatus.Type): StatusSummary => {
  if (status.runState === 'starting') return { tone: 'info', label: 'Starting' }
  if (status.runState === 'running') {
    return ServerStatus.healthOf(status).pipe(
      Option.map(runningStatus),
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
 * What the status says beyond the run state, with the host's reason a
 * running server isn't reachable when it has one; nothing for a server
 * that is plainly running or stopped, which the dot says alone.
 */
const statusNote = (status: ServerStatus.Type): Option.Option<string> => {
  if (status.runState === 'stopped') return Option.none()
  const health = Option.getOrNull(ServerStatus.healthOf(status))
  if (health?.kind === 'reachable' && health.status === 'pass') return Option.none()
  const { label } = statusSummary(status)
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
