/**
 * The background server service's pure core: `BackgroundServerServiceBridge`,
 * the host's status snapshot of the server it runs and the page's request to
 * restart it.
 *
 * @packageDocumentation
 */
export {
  BackgroundServerServiceBridge,
  NotificationPermission,
  RestartServer,
  ServerServiceState,
  ServerServiceStatus,
  ServiceStopReason,
} from './bridge.ts'
