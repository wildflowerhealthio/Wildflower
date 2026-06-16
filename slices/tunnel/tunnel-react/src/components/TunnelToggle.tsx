import { Match, Predicate } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, StatusBadge, type StatusTone } from 'react-tundraish'

import styles from './TunnelToggle.module.css'

interface TunnelTogglePropsBase {
  /** Owner intent: `true` if the daemon has been asked to run the tunnel. */
  readonly requestedRunning: boolean
  /**
   * Daemon-observed state. Optimistic: `true` means *dialing or
   * reconnecting*, not a confirmed connection (rathole exposes no
   * handshake-complete signal). Surfaces as the badge tone.
   */
  readonly running: boolean
  /** Latest daemon-reported error, if any. `null` = no error. */
  readonly error: string | null
  readonly className?: string
}

type TunnelToggleProps = TunnelTogglePropsBase &
  (
    | { readonly disabled: true; readonly onToggle?: (requestedRunning: boolean) => void }
    | { readonly disabled?: false; readonly onToggle: (requestedRunning: boolean) => void }
  )

interface TunnelToggleStatus {
  /** Surface tone for the status badge — drives accent color + SR prefix. */
  readonly tone: StatusTone
  /** Short, human-readable status label (e.g. "Online", "Starting…", "Stopped"). */
  readonly label: string
}

/**
 * Decision table over `(requestedRunning, running, error)`:
 * - `(_,    _,    err)`    → `danger` "Error" — failure first, regardless of intent/reality
 * - `(true, true, null)`   → `success` "Online"
 * - `(true, false, null)`  → `info` "Starting…"
 * - `(false, true, null)`  → `warning` "Stopping…"
 * - `(false, false, null)` → `neutral` "Stopped"
 */
const deriveTunnelStatus: (input: {
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly error: string | null
}) => TunnelToggleStatus = Match.type<{
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly error: string | null
}>().pipe(
  Match.withReturnType<TunnelToggleStatus>(),
  Match.when({ error: Predicate.isString }, () => ({ tone: 'danger', label: 'Error' })),
  Match.when({ requestedRunning: true, running: true }, () => ({
    tone: 'success',
    label: 'Online',
  })),
  Match.when({ requestedRunning: true, running: false }, () => ({
    tone: 'info',
    label: 'Starting…',
  })),
  Match.when({ requestedRunning: false, running: true }, () => ({
    tone: 'warning',
    label: 'Stopping…',
  })),
  Match.orElse(() => ({ tone: 'neutral', label: 'Stopped' }))
)

/**
 * Toggle that drives the tunnel's `requestedRunning` flag and surfaces
 * the daemon's actual `running` state alongside any current error.
 *
 * The checkbox tracks owner intent (`requestedRunning`). The status
 * badge tracks reality (`running` + `error`). They can disagree
 * transiently — e.g. immediately after a click, while the daemon is
 * still spinning up — which is the point: the user sees what they
 * asked for and what's actually happening at the same time.
 *
 * The component is presentation-only; it does *not* call the API. The
 * parent (`TunnelScreen`, or an embedding host) wires `onToggle` to the
 * `ReplaceTunnel` runner.
 */
const TunnelToggle = (props: TunnelToggleProps): JSX.Element => {
  const { requestedRunning, running, error, className } = props
  const status = deriveTunnelStatus({ requestedRunning, running, error })

  return (
    <div className={cn(styles['toggle'], className)}>
      <div className={styles['toggle__row']}>
        <Checkbox
          checked={requestedRunning}
          label="Run tunnel"
          {...(props.disabled === true
            ? { disabled: true }
            : {
                disabled: false,
                onChange: (next) => {
                  props.onToggle(next)
                },
              })}
        />
        <span className={styles['toggle__status']}>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </span>
      </div>
      {error !== null ? (
        <span className={cn(styles['toggle__meta'], 'text-body-3')} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export { TunnelToggle }
export type { TunnelToggleProps }
