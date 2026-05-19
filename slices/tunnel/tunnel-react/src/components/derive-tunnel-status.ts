import type { StatusTone } from 'react-tundraish'

interface TunnelToggleStatus {
  /** Surface tone for the status badge — drives accent color + SR prefix. */
  readonly tone: StatusTone
  /** Short, human-readable status label (e.g. "Online", "Starting…", "Stopped"). */
  readonly label: string
}

/**
 * Derive the {@link TunnelToggleStatus} from the merged tunnel state.
 * Exported so screens and tests can render the same labels the toggle
 * does without reaching into UI internals.
 *
 * Decision table (requestedRunning, running, error):
 * - `(_,    _,    err)` → `danger` "Error" — surface the failure first
 *   regardless of the owner's intent or daemon state
 * - `(true, true, null)` → `success` "Online"
 * - `(true, false, null)` → `info` "Starting…"
 * - `(false, true, null)` → `warning` "Stopping…"
 * - `(false, false, null)` → `neutral` "Stopped"
 */
const deriveTunnelStatus = (
  requestedRunning: boolean,
  running: boolean,
  error: string | null
): TunnelToggleStatus => {
  if (error !== null) return { tone: 'danger', label: 'Error' }
  if (requestedRunning && running) return { tone: 'success', label: 'Online' }
  if (requestedRunning && !running) return { tone: 'info', label: 'Starting…' }
  if (!requestedRunning && running) return { tone: 'warning', label: 'Stopping…' }
  return { tone: 'neutral', label: 'Stopped' }
}

export { deriveTunnelStatus }
export type { TunnelToggleStatus }
