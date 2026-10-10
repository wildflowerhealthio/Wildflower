import type { StatusTone } from '@wildflowerhealthio/react-tundraish'
import type {
  NotificationPermission,
  ServerServiceState,
  ServerServiceStatus,
  ServiceStopReason,
} from '@wildflowerhealthio/wildflower-server-core-js'

/**
 * The state the page shows a status as: the host's own state, plus
 * `restarting` for the gap between a restart's stop and its new run.
 */
type ServerDisplayState = ServerServiceState | 'restarting'

/**
 * The state to show `status` as. A clean `appStop` stop is the stop half of a
 * restart (the host stops with it only to restart, and posts no notification
 * for it), so it shows as `restarting` rather than as a stop: the next snapshot
 * is the new run's `starting`. Should that start fail, the host replaces
 * `appStop` with `error`, which shows as a stop.
 */
const serverDisplayState = (status: ServerServiceStatus): ServerDisplayState =>
  status.state === 'stopped' && status.stopReason === 'appStop' && status.lastError === null
    ? 'restarting'
    : status.state

/** The badge label for each displayed state. */
const SERVER_STATE_LABEL: Readonly<Record<ServerDisplayState, string>> = {
  starting: 'Starting',
  restarting: 'Restarting',
  running: 'Running',
  stopped: 'Stopped',
}

/**
 * Why the server stopped, as a sentence, for each stop reason the host
 * reports.
 */
const STOP_REASON_DESCRIPTION: Readonly<Record<ServiceStopReason, string>> = {
  userStop: 'It was stopped.',
  appStop: 'It was stopped to restart.',
  platformTimeout: 'Android ended its background time.',
  platformExpiration: 'iOS ended the background window.',
  nativeNotificationStop: 'It was stopped from its notification.',
  osRestart: 'The system restarted the service.',
  bootRecovery: 'It stopped while recovering after the device restarted.',
  taskCompleted: 'It stopped on its own.',
  error: 'It stopped after an error.',
  processExit: 'The app was closed or put in the background.',
}

/** Whether the host may post notifications, as the settings page says it. */
const NOTIFICATION_PERMISSION_LABEL: Readonly<Record<NotificationPermission, string>> = {
  granted: 'On',
  denied: 'Off',
  unknown: 'Unknown',
}

/** The badge tone for a displayed state that isn't a stop. */
const NOT_STOPPED_TONE: Readonly<Record<Exclude<ServerDisplayState, 'stopped'>, StatusTone>> = {
  starting: 'info',
  restarting: 'info',
  running: 'success',
}

/**
 * The badge tone for a status: calm (`info`) while starting or restarting,
 * `success` while running, and for a stop `danger` when it stopped with an
 * error, `warning` otherwise.
 */
const serverStatusTone = (status: ServerServiceStatus): StatusTone => {
  const displayState = serverDisplayState(status)
  if (displayState !== 'stopped') return NOT_STOPPED_TONE[displayState]
  return status.lastError === null ? 'warning' : 'danger'
}

export type { ServerDisplayState }
export {
  NOTIFICATION_PERMISSION_LABEL,
  SERVER_STATE_LABEL,
  serverDisplayState,
  serverStatusTone,
  STOP_REASON_DESCRIPTION,
}
