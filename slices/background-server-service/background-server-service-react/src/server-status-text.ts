import type {
  NotificationPermission,
  ServerServiceState,
  ServerServiceStatus,
  ServiceStopReason,
} from 'background-server-service-core'
import type { StatusTone } from 'react-tundraish'

/** The badge label for each server state. */
const SERVER_STATE_LABEL: Readonly<Record<ServerServiceState, string>> = {
  starting: 'Starting',
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
  unknown: 'Not decided yet',
}

/** The badge tone for a status that isn't a stop. */
const NOT_STOPPED_TONE: Readonly<Record<Exclude<ServerServiceState, 'stopped'>, StatusTone>> = {
  starting: 'info',
  running: 'success',
}

/**
 * The badge tone for a status: calm (`info`) while starting, `success` while
 * running, and for a stop `danger` when it stopped with an error, `warning`
 * otherwise.
 */
const serverStatusTone = (status: ServerServiceStatus): StatusTone => {
  if (status.state !== 'stopped') return NOT_STOPPED_TONE[status.state]
  return status.lastError === null ? 'warning' : 'danger'
}

export {
  NOTIFICATION_PERMISSION_LABEL,
  SERVER_STATE_LABEL,
  serverStatusTone,
  STOP_REASON_DESCRIPTION,
}
