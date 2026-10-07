import type { Effect } from 'effect'
import { Schema } from 'effect'

import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * How the host's unit runner starts its background session, the
 * background-service plugin's one service: on Android, the text of its
 * persistent notification and its foreground-service type.
 */
interface BackgroundServiceStartConfig {
  readonly serviceLabel: string
  readonly foregroundServiceType: string
}

/**
 * Record that the background session should keep running, started with
 * `startConfig`, so the background-service plugin starts it again after the
 * OS ends the app: in an iOS background window, or through Android's
 * tap-to-resume notification. The servers run either way; this only buys
 * those restarts.
 *
 * @remarks
 * `startConfig` must be the one the host's `TauriUnitRunner` starts with,
 * which both read from the app's `tauri-shared-config.json`.
 */
const enableBackgroundSessionRecovery = (
  startConfig: BackgroundServiceStartConfig
): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('plugin:background-service|configure_recovery', Schema.Null, {
    enabled: true,
    config: startConfig,
  })

export { enableBackgroundSessionRecovery }
export type { BackgroundServiceStartConfig }
