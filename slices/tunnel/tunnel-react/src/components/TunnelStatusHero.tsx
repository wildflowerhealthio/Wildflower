import { Match, Predicate } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge, ToggleSwitch, type StatusTone } from 'react-tundraish'

import { isTunnelOpen, type TunnelState } from '../queries.ts'
import styles from './TunnelStatusHero.module.css'

interface TunnelStatusHeroPropsBase {
  readonly state: TunnelState
  readonly className?: string
}

/**
 * Mirrors the `Checkbox`/`ToggleSwitch` discriminated union: a disabled
 * hero may omit `onToggle` entirely (e.g. while a pending mutation locks
 * the control); an enabled hero must supply one.
 */
type TunnelStatusHeroProps = TunnelStatusHeroPropsBase &
  (
    | { readonly disabled: true; readonly onToggle?: (next: boolean) => void }
    | { readonly disabled?: false; readonly onToggle: (next: boolean) => void }
  )

interface HeroStatus {
  readonly tone: StatusTone
  readonly label: string
}

/**
 * Decision table over `(requestedRunning, running, error)`. Same shape
 * as the prior `TunnelToggle.deriveTunnelStatus` so the badge tone+label
 * mapping survives the hero migration unchanged.
 *
 * - any error                → `danger` "Error"
 * - (true,  true,  null)     → `success` "Online"
 * - (true,  false, null)     → `info` "Starting…"
 * - (false, true,  null)     → `warning` "Stopping…"
 * - (false, false, null)     → `neutral` "Off"
 */
const deriveHeroStatus: (input: {
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly error: string | null
}) => HeroStatus = Match.type<{
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly error: string | null
}>().pipe(
  Match.withReturnType<HeroStatus>(),
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
  Match.orElse(() => ({ tone: 'neutral', label: 'Off' }))
)

interface ConnectionPathProps {
  /**
   * `true` when the tunnel is open (running or about to be) — paints the
   * relay node in full accent + ring and the internet node green. `false`
   * dims the relay to a paler accent shade (configured but not linked)
   * and grays the internet node (no exit). "This device" stays green in
   * both states.
   */
  readonly open: boolean
  /**
   * `true` when the daemon is reporting an error — the relay node turns
   * red (the same danger ramp the badge and inline alert use) to mark
   * the chain's failure pivot. Wins over `open`, so a red relay is
   * shown even when the tunnel is running and an error has surfaced
   * mid-flight.
   */
  readonly error: boolean
  readonly className?: string
}

/*
 * Pick the relay node's variant modifier. Error wins over open, since a
 * red relay surfaced mid-flight is the more useful signal than the
 * "configured" accent — same precedence the status badge uses.
 */
const relayVariantClass = (open: boolean, error: boolean): string | null => {
  if (error) return styles['path__node--error']
  if (!open) return styles['path__node--inactive']
  return null
}

/**
 * Three-node connection chain — `this device → relay → internet`. Lives
 * outside the address-block dim so the per-node colors stay vivid in
 * both states; activity is communicated by node color, not opacity.
 */
const ConnectionPath = ({ open, error, className }: ConnectionPathProps): JSX.Element => (
  <div className={cn(styles['path'], className)} aria-hidden="true">
    <div className={styles['path__nodes']}>
      <span className={cn(styles['path__node'], styles['path__node--device'])} />
      <span className={styles['path__connector']} />
      <span
        className={cn(
          styles['path__node'],
          styles['path__node--relay'],
          relayVariantClass(open, error)
        )}
      />
      <span className={styles['path__connector']} />
      <span
        className={cn(
          styles['path__node'],
          styles['path__node--internet'],
          open ? null : styles['path__node--inactive']
        )}
      />
    </div>
    <div className={styles['path__labels']}>
      <span>This device</span>
      <span>Relay</span>
      <span>Internet</span>
    </div>
  </div>
)

/*
 * Async-clipboard write with a graceful fallback. The Clipboard API
 * isn't guaranteed (older WebView contexts, non-secure origins, denied
 * permission); a failed copy stays silent rather than throwing into a
 * click handler. A future slice can wire toast feedback.
 */
const writeToClipboard = async (text: string): Promise<void> => {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Best-effort — clipboard writes can reject (permissions, focus); the
    // host glyph already shows the host the user wanted to copy.
  }
}

/**
 * The Tunnel screen's status hero card.
 *
 * Layout:
 *   - top row: the live `Run tunnel` switch + a status badge (Online,
 *     Starting…, Stopping…, Off, or Error) that pulses while Online.
 *   - error message (when present) below the top row.
 *   - address block (dims when the tunnel isn't open):
 *       · public host + copy button
 *       · "N apps connected now" sub-line (stubbed at `0` — there is no
 *         live connection-count source yet; see TODO)
 *       · three-node connection path.
 *
 * Toggling the switch is the live tunnel control — no Save step. The
 * parent wires `onToggle` to the `ReplaceTunnel` mutation.
 */
const TunnelStatusHero = (props: TunnelStatusHeroProps): JSX.Element => {
  const { state, className } = props
  const status = deriveHeroStatus({
    requestedRunning: state.requestedRunning,
    running: state.running,
    error: state.error,
  })
  const open = isTunnelOpen(state)
  const hostText = state.publicHost ?? 'No public host set'
  /*
   * Active-connection count is stubbed at 0 — there is no live source in
   * `TunnelState` for it today (see the slice handoff). Annotated `number`
   * (not the literal `0`) so the singular-vs-plural branch below stays
   * meaningful once a real count lands.
   */
  const connectionsCount: number = 0

  const handleToggle = (next: boolean): void => {
    if (props.disabled === true) return
    props.onToggle(next)
  }

  const handleCopy = (): void => {
    if (state.publicHost === null) return
    void writeToClipboard(state.publicHost)
  }

  return (
    <section className={cn(styles['hero'], className)}>
      <div className={styles['hero__top']}>
        {props.disabled === true ? (
          <ToggleSwitch checked={state.requestedRunning} disabled label="Run tunnel" />
        ) : (
          <ToggleSwitch
            checked={state.requestedRunning}
            label="Run tunnel"
            onChange={handleToggle}
          />
        )}
        <StatusBadge tone={status.tone} pulse={status.tone === 'success'}>
          {status.label}
        </StatusBadge>
      </div>
      {state.error !== null ? (
        <p className={styles['hero__error']} role="alert">
          {state.error}
        </p>
      ) : null}
      <div className={cn(styles['hero__address'], open ? null : styles['hero__address--dim'])}>
        <div className={styles['hero__address-row']}>
          <span className={styles['hero__host']}>{hostText}</span>
          <button
            type="button"
            className={styles['hero__copy']}
            onClick={handleCopy}
            disabled={state.publicHost === null}
            aria-label="Copy public host"
          >
            &#x2398;
          </button>
        </div>
        <p className={styles['hero__meta']}>
          {connectionsCount === 1
            ? '1 app connected now'
            : `${connectionsCount} apps connected now`}
        </p>
      </div>
      <ConnectionPath open={open} error={state.error !== null} />
    </section>
  )
}

export { TunnelStatusHero }
export type { TunnelStatusHeroProps }
