import { useMatchRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { useServerServiceStatus } from './server-service-status-store.ts'
import { serverDisplayState, STOP_REASON_DESCRIPTION } from './server-status-text.ts'
import { useRestartServer } from './use-restart-server.ts'
import styles from './server-status-banner.module.css'

/** The banner's headline for each state it shows. */
const BANNER_TITLE = {
  starting: 'Server starting…',
  restarting: 'Server restarting…',
  stopped: 'Server stopped',
} as const

/**
 * A strip across the top of the app while the Wildflower server isn't running:
 * one row with a status dot, what the server is doing, why it stopped and the
 * error it stopped with, and, for a stop, a Restart button.
 *
 * @remarks
 * Renders nothing before the host's first status snapshot and while the server
 * runs. Starting and restarting are a calm neutral strip with neither a reason
 * nor Restart: the server is already on its way back, and a starting run still
 * carries the previous run's reason (a restart's own `appStop`), which says
 * nothing about this one. The stop half of a restart counts as restarting (see
 * `serverDisplayState`). A stop takes the warning surface; the server page
 * offers Restart in every state.
 *
 * Hidden on `/settings/server` itself, which shows the same status in full
 * with its own Restart. Renders inside the router, as the app shell's
 * `platformBanner`. Only the Tauri entry mounts the banner, since only its
 * host runs the server.
 */
const ServerStatusBanner = (): JSX.Element | null => {
  const status = useServerServiceStatus()
  const restartServer = useRestartServer()
  const isOnServerPage = useMatchRoute()({ to: '/settings/server' }) !== false
  if (status === null || isOnServerPage) return null
  const displayState = serverDisplayState(status)
  if (displayState === 'running') return null
  const isStopped = displayState === 'stopped'
  return (
    <section
      aria-label="Wildflower server"
      className={cn(
        styles['server-status-banner'],
        isStopped ? styles['server-status-banner--stopped'] : null
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          styles['server-status-banner__dot'],
          isStopped && status.lastError !== null ? styles['server-status-banner__dot--error'] : null
        )}
      />
      <div className={styles['server-status-banner__text']}>
        <p className={styles['server-status-banner__title']}>{BANNER_TITLE[displayState]}</p>
        {isStopped && status.stopReason !== null ? (
          <p className={styles['server-status-banner__detail']}>
            {STOP_REASON_DESCRIPTION[status.stopReason]}
          </p>
        ) : null}
        {isStopped && status.lastError !== null ? (
          <p className={styles['server-status-banner__error']} role="alert">
            {status.lastError}
          </p>
        ) : null}
      </div>
      {isStopped ? (
        <button
          type="button"
          className={cn('button-3 outline', styles['server-status-banner__action'])}
          onClick={restartServer}
        >
          Restart
        </button>
      ) : null}
    </section>
  )
}

export { ServerStatusBanner }
