import type { Effect } from 'effect'
import { Schema } from 'effect'

import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * The app's version, the `version` of the host's `tauri.conf.json`, e.g.
 * `0.4.0`, as Tauri's own `plugin:app|version` answers it.
 */
const readAppVersion: Effect.Effect<string, HostCommandError, TauriInvoke> = invokeHostCommand(
  'plugin:app|version',
  Schema.String
)

export { readAppVersion }
