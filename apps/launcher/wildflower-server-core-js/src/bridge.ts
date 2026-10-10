import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * The background server service's channel: the host's status snapshot of the
 * Wildflower server it runs, and the page's request to restart it.
 *
 * @remarks
 * The page keeps no state of its own: the host emits a fresh
 * {@link ServerServiceStatus} on every change and in reply to every `__Ready`,
 * and the page renders the latest one.
 *
 * The wire strings below are pinned by `test/bridge-wire-golden.json` — see the
 * [Wire Pinning How-To](../../../../docs/Messaging/Wire%20Pinning%20How-To.md).
 *
 * @packageDocumentation
 */

/**
 * Where the server's current run is: `starting` (setting up and binding),
 * `running` (serving), or `stopped`.
 */
const ServerServiceState = Schema.Literal('starting', 'running', 'stopped')
type ServerServiceState = Schema.Schema.Type<typeof ServerServiceState>

/**
 * Why a run of the background service stopped, in
 * `tauri-plugin-background-service`'s own camelCase names.
 *
 * @remarks
 * `appStop` is the stop half of a restart (from the page, or on a foreground
 * resume); the server comes straight back after it.
 */
const ServiceStopReason = Schema.Literal(
  'userStop',
  'appStop',
  'platformTimeout',
  'platformExpiration',
  'nativeNotificationStop',
  'osRestart',
  'bootRecovery',
  'taskCompleted',
  'error',
  'processExit'
)
type ServiceStopReason = Schema.Schema.Type<typeof ServiceStopReason>

/**
 * Whether the host may post notifications: `unknown` when the OS has not asked
 * yet or the host could not read it.
 */
const NotificationPermission = Schema.Literal('granted', 'denied', 'unknown')
type NotificationPermission = Schema.Schema.Type<typeof NotificationPermission>

/**
 * Host → Web: the server service's current status.
 *
 * @remarks
 * - `stopReason` is why the most recent run stopped, `null` until one has. It
 *   outlives that run: a run starting after a restart still carries the
 *   previous run's `appStop`.
 * - `lastError` is the error the most recent run stopped with, as the server's
 *   full error chain; `null` while a run is starting or running, and when it
 *   stopped cleanly.
 *
 * Wire:
 * `{"_tag":"ServerServiceStatus","state":"running","stopReason":null,"lastError":null,"notifications":"granted"}`,
 * `{"_tag":"ServerServiceStatus","state":"stopped","stopReason":"platformExpiration","lastError":"failed to bind to 127.0.0.1:8080: Address already in use","notifications":"denied"}`,
 * `{"_tag":"ServerServiceStatus","state":"starting","stopReason":"appStop","lastError":null,"notifications":"unknown"}`.
 */
const ServerServiceStatus = Schema.parseJson(
  Schema.TaggedStruct('ServerServiceStatus', {
    state: ServerServiceState,
    stopReason: Schema.NullOr(ServiceStopReason),
    lastError: Schema.NullOr(Schema.String),
    notifications: NotificationPermission,
  })
)
type ServerServiceStatus = Schema.Schema.Type<typeof ServerServiceStatus>

/**
 * Web → Host: stop the server if it is running, then start it.
 *
 * @remarks
 * The host answers through the next {@link ServerServiceStatus}s (`starting`,
 * then `running` or `stopped`), not with a reply of its own.
 *
 * Wire: `{"_tag":"RestartServer"}`
 */
const RestartServer = Schema.parseJson(Schema.TaggedStruct('RestartServer', {}))
type RestartServer = Schema.Schema.Type<typeof RestartServer>

type BackgroundServerServiceBridge = Bridge.Bridge<
  'BackgroundServerService',
  {
    ServerServiceStatus: typeof ServerServiceStatus
  },
  {
    RestartServer: typeof RestartServer
  }
>

/**
 * Slice-level bridge between the page and the Tauri host that runs the
 * Wildflower server as a background service.
 *
 * @remarks
 * One snapshot host → web and one request web → host. The server's health
 * through its public origin is not on this bridge: the host reads it
 * in-process.
 */
const BackgroundServerServiceBridge: BackgroundServerServiceBridge = Bridge.make({
  name: 'BackgroundServerService',
  hostToWeb: [['ServerServiceStatus', ServerServiceStatus]] as const,
  webToHost: [['RestartServer', RestartServer]] as const,
})

export {
  BackgroundServerServiceBridge,
  NotificationPermission,
  RestartServer,
  ServerServiceState,
  ServerServiceStatus,
  ServiceStopReason,
}
