import type { Effect } from 'effect'
import { Schema } from 'effect'

import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * Whether the OS lets the app post notifications: `granted`, `denied`, or
 * `prompt` while the OS has yet to ask (it asks when the app requests it).
 *
 * @remarks
 * The host asks on its own the first time it starts a server; Settings shows
 * the answer and asks while it is `prompt`. Desktop systems answer `granted`
 * without asking.
 */
const NotificationPermission = Schema.Literal('granted', 'denied', 'prompt')
type NotificationPermission = typeof NotificationPermission.Type

/**
 * The notification plugin's `is_permission_granted` answer, `true`, `false`,
 * or `null` while the OS has yet to ask, as a {@link NotificationPermission}.
 */
const PermissionGrantedAnswer = Schema.transformLiterals(
  [true, 'granted'],
  [false, 'denied'],
  [null, 'prompt']
)

/**
 * The notification plugin's `request_permission` answer, Tauri's
 * `PermissionState` as its display string, as a {@link NotificationPermission}.
 * Android's `prompt-with-rationale` (the user said no once, and may be asked
 * again with a reason) is `prompt`.
 */
const PermissionStateAnswer = Schema.transformLiterals(
  ['granted', 'granted'],
  ['denied', 'denied'],
  ['prompt', 'prompt'],
  ['prompt-with-rationale', 'prompt']
)

/** Read whether the OS lets the app post notifications, without asking. */
const readNotificationPermission: Effect.Effect<
  NotificationPermission,
  HostCommandError,
  TauriInvoke
> = invokeHostCommand('plugin:notification|is_permission_granted', PermissionGrantedAnswer)

/**
 * Ask the OS to let the app post notifications, answering with the
 * permission it holds after. The OS shows its prompt only while the
 * permission is `prompt`; otherwise it answers at once with what it holds.
 */
const requestNotificationPermission: Effect.Effect<
  NotificationPermission,
  HostCommandError,
  TauriInvoke
> = invokeHostCommand('plugin:notification|request_permission', PermissionStateAnswer)

export { NotificationPermission, readNotificationPermission, requestNotificationPermission }
