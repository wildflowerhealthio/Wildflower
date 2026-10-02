import type { ServerServiceStatus } from 'background-server-service-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'

import { useServerServiceStatus } from './server-service-status-store.ts'
import {
  SERVER_STATE_LABEL,
  serverStatusTone,
  STOP_REASON_DESCRIPTION,
} from './server-status-text.ts'
import { useRestartServer } from './use-restart-server.ts'
import styles from './server-status-banner.module.css'

/** What the banner says about a server that isn't running. */
const bannerMessage = (status: ServerServiceStatus): string => {
  if (status.state === 'starting') return 'The Wildflower server is starting.'
  const reason = status.stopReason === null ? '' : ` ${STOP_REASON_DESCRIPTION[status.stopReason]}`
  return `The Wildflower server isn't running.${reason}`
}

/**
 * A strip across the top of the app while the Wildflower server isn't running:
 * its state, why it stopped and the error it stopped with, and a Restart button.
 *
 * @remarks
 * Renders nothing before the host's first status snapshot and while the server
 * runs. `starting` is shown calmly, without the stop reason: a starting run
 * still carries the previous run's reason (a restart's own `appStop`), which
 * says nothing about this one. Only the Tauri entry mounts the banner, since
 * only its host runs the server.
 */
const ServerStatusBanner = (): JSX.Element | null => {
  const status = useServerServiceStatus()
  const restartServer = useRestartServer()
  if (status === null || status.state === 'running') return null
  const isStopped = status.state === 'stopped'
  return (
    <section
      aria-label="Wildflower server"
      className={cn(
        styles['server-status-banner'],
        isStopped ? styles['server-status-banner--stopped'] : null
      )}
    >
      <div className={styles['server-status-banner__summary']}>
        <StatusBadge tone={serverStatusTone(status)}>
          {SERVER_STATE_LABEL[status.state]}
        </StatusBadge>
        <p className={cn(styles['server-status-banner__message'], 'text-body-3')}>
          {bannerMessage(status)}
        </p>
        <button type="button" className="button-3 outline" onClick={restartServer}>
          Restart
        </button>
      </div>
      {isStopped && status.lastError !== null ? (
        <p className={cn(styles['server-status-banner__error'], 'text-body-3')} role="alert">
          {status.lastError}
        </p>
      ) : null}
    </section>
  )
}

export { ServerStatusBanner }
