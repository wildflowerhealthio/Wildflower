import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, StatusBadge } from 'react-tundraish'

import { deriveTunnelStatus } from './derive-tunnel-status.ts'
import styles from './TunnelToggle.module.css'

interface TunnelTogglePropsBase {
  /** Owner intent: `true` if the daemon has been asked to run the tunnel. */
  readonly requestedRunning: boolean
  /** Daemon-observed running state. Surfaces as the badge tone. */
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
 * `PatchTunnel` runner.
 */
const TunnelToggle = (props: TunnelToggleProps): JSX.Element => {
  const { requestedRunning, running, error, className } = props
  const status = deriveTunnelStatus(requestedRunning, running, error)

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
