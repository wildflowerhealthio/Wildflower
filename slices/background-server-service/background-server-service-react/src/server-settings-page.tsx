import type { ServerServiceStatus } from 'background-server-service-core'
import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageHeader, StatusBadge } from 'react-tundraish'

import { useServerServiceStatus } from './server-service-status-store.ts'
import {
  NOTIFICATION_PERMISSION_LABEL,
  type ServerDisplayState,
  SERVER_STATE_LABEL,
  serverDisplayState,
  serverStatusTone,
  STOP_REASON_DESCRIPTION,
} from './server-status-text.ts'
import { ServerTunnelStatus } from './server-tunnel-status.tsx'
import { useRestartServer } from './use-restart-server.ts'
import styles from './server-settings-page.module.css'

/** What the Tunnel section says while the server isn't running. */
const NO_TUNNEL_MESSAGE: Readonly<Record<Exclude<ServerDisplayState, 'running'>, string>> = {
  starting: 'The tunnel starts once the server is running.',
  restarting: 'The tunnel starts once the server is running.',
  stopped: 'The tunnel runs inside the server, so there is no tunnel while it is stopped.',
}

/** One label/value row of the status card. */
const StatusRow = ({
  label,
  stacked = false,
  children,
}: {
  readonly label: string
  readonly stacked?: boolean
  readonly children: ReactNode
}): JSX.Element => (
  <div
    className={cn(
      styles['server-settings-page__row'],
      stacked ? styles['server-settings-page__row--stacked'] : null
    )}
  >
    <dt className={styles['server-settings-page__label']}>{label}</dt>
    <dd className={styles['server-settings-page__value']}>{children}</dd>
  </div>
)

/** Every field of one status snapshot, and the tunnel while the server runs. */
const ServerStatusDetails = ({ status }: { readonly status: ServerServiceStatus }): JSX.Element => {
  const displayState = serverDisplayState(status)
  return (
    <>
      <section className={styles['server-settings-page__section']} aria-label="Status">
        <h2 className={styles['server-settings-page__heading']}>Status</h2>
        <dl className={styles['server-settings-page__card']}>
          <StatusRow label="State">
            <StatusBadge tone={serverStatusTone(status)}>
              {SERVER_STATE_LABEL[displayState]}
            </StatusBadge>
          </StatusRow>
          <StatusRow label="Notifications">
            {NOTIFICATION_PERMISSION_LABEL[status.notifications]}
          </StatusRow>
          <StatusRow label="Last stop reason" stacked>
            {status.stopReason === null ? 'None yet' : STOP_REASON_DESCRIPTION[status.stopReason]}
          </StatusRow>
          <StatusRow label="Last error" stacked>
            {status.lastError === null ? (
              'None'
            ) : (
              <span className={styles['server-settings-page__error']}>{status.lastError}</span>
            )}
          </StatusRow>
        </dl>
      </section>
      <section className={styles['server-settings-page__section']} aria-label="Tunnel">
        <h2 className={styles['server-settings-page__heading']}>Tunnel</h2>
        {displayState === 'running' ? (
          <ServerTunnelStatus />
        ) : (
          <p className={styles['server-settings-page__note']}>{NO_TUNNEL_MESSAGE[displayState]}</p>
        )}
      </section>
    </>
  )
}

/**
 * The `/settings/server` page: the Wildflower server's state, why it last
 * stopped and the error it stopped with, whether notifications are on, and,
 * while it runs, the tunnel's status and public host.
 *
 * @remarks
 * Renders the host's latest status snapshot and nothing else; before the first
 * one arrives it says it is waiting. Restart is offered in every state.
 * `backgroundServerServiceSettingsItemsFragment` is the Settings row that links
 * here.
 */
const ServerSettingsPage = (): JSX.Element => {
  const status = useServerServiceStatus()
  const restartServer = useRestartServer()
  return (
    <>
      <PageHeader
        title="Server"
        backHref="/settings"
        backLabel="Settings"
        actions={
          <button type="button" className="button-3 outline" onClick={restartServer}>
            Restart
          </button>
        }
      />
      {status === null ? (
        <p className="text-body-2" role="status">
          Waiting for the server status…
        </p>
      ) : (
        <ServerStatusDetails status={status} />
      )}
    </>
  )
}

export { ServerSettingsPage }
