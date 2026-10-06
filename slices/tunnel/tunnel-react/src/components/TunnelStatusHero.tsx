import { Match, Predicate } from 'effect'
import type { JSX } from 'react'
import { cn, writeToClipboard } from 'react-kitchen-sink'
import { StatusBadge, type StatusTone } from 'react-tundraish'

import type { TunnelState } from '../queries/index.ts'
import styles from './TunnelStatusHero.module.css'

interface TunnelStatusHeroProps {
  readonly state: TunnelState
  readonly className?: string
}

interface HeroStatus {
  readonly tone: StatusTone
  readonly label: string
}

/**
 * Decision table over `(status, error)`.
 *
 * - any error                → `danger` "Error"
 * - `verified`               → `success` "Online"
 * - `dialing`/`unreachable`  → `info` "Connecting…"
 * - `off`                    → `neutral` "Off"
 */
const deriveHeroStatus: (input: Pick<TunnelState, 'status' | 'error'>) => HeroStatus = Match.type<
  Pick<TunnelState, 'status' | 'error'>
>().pipe(
  Match.withReturnType<HeroStatus>(),
  Match.when({ error: Predicate.isString }, () => ({ tone: 'danger', label: 'Error' })),
  Match.when({ status: 'verified' }, () => ({ tone: 'success', label: 'Online' })),
  Match.when({ status: 'off' }, () => ({ tone: 'neutral', label: 'Off' })),
  Match.orElse(() => ({ tone: 'info', label: 'Connecting…' }))
)

interface ConnectionPathProps {
  /**
   * `true` when the tunnel is running — paints the
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

/**
 * The Tunnel screen's status hero card, read-only: the base owns the server's
 * tunnel, so nothing here changes it.
 *
 * Layout:
 *   - top row: a status badge (Online, Connecting…, Off, or Error) that pulses
 *     while Online.
 *   - error message (when present) below the top row.
 *   - address block (dims when the tunnel isn't running):
 *       · public host + copy button
 *       · "N apps connected now" sub-line (stubbed at `0` — there is no
 *         live connection-count source yet)
 *       · three-node connection path.
 */
const TunnelStatusHero = ({ state, className }: TunnelStatusHeroProps): JSX.Element => {
  const status = deriveHeroStatus(state)
  const open = state.running
  /*
   * Active-connection count is stubbed at 0 — there is no live source in
   * `TunnelState` for it today. Annotated `number` (not the literal `0`) so the
   * singular-vs-plural branch below stays meaningful once a real count lands.
   */
  const connectionsCount: number = 0

  const handleCopy = (): void => {
    void writeToClipboard(state.publicHost)
  }

  return (
    <section className={cn(styles['hero'], className)}>
      <div className={styles['hero__top']}>
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
          <span className={styles['hero__host']}>{state.publicHost}</span>
          <button
            type="button"
            className={styles['hero__copy']}
            onClick={handleCopy}
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
