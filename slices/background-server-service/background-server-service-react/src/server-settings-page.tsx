import type { ServerServiceState, ServerServiceStatus } from 'background-server-service-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, PageHeader, StatusBadge } from 'react-tundraish'

import { useServerServiceStatus } from './server-service-status-store.ts'
import {
  NOTIFICATION_PERMISSION_LABEL,
  SERVER_STATE_LABEL,
  serverStatusTone,
  STOP_REASON_DESCRIPTION,
} from './server-status-text.ts'
import { ServerTunnelStatus } from './server-tunnel-status.tsx'
import { useRestartServer } from './use-restart-server.ts'
import styles from './server-settings-page.module.css'

/** What the Tunnel section says while the server isn't running. */
const NO_TUNNEL_MESSAGE: Readonly<Record<Exclude<ServerServiceState, 'running'>, string>> = {
  starting: 'The tunnel starts once the server is running.',
  stopped: 'The tunnel runs inside the server, so there is no tunnel while it is stopped.',
}

/** Every field of one status snapshot, and the tunnel while the server runs. */
const ServerStatusDetails = ({ status }: { readonly status: ServerServiceStatus }): JSX.Element => (
  <>
    <div className={styles['server-settings-page__fields']}>
      <Field label="State">
        <span>
          <StatusBadge tone={serverStatusTone(status)}>
            {SERVER_STATE_LABEL[status.state]}
          </StatusBadge>
        </span>
      </Field>
      <Field label="Last stop reason">
        <span className="text-body-2">
          {status.stopReason === null ? 'None yet' : STOP_REASON_DESCRIPTION[status.stopReason]}
        </span>
      </Field>
      <Field label="Last error">
        {status.lastError === null ? (
          <span className="text-body-2">None</span>
        ) : (
          <p className={cn(styles['server-settings-page__error'], 'text-body-3')}>
            {status.lastError}
          </p>
        )}
      </Field>
      <Field label="Notifications">
        <span className="text-body-2">{NOTIFICATION_PERMISSION_LABEL[status.notifications]}</span>
      </Field>
    </div>
    <section className={styles['server-settings-page__tunnel']} aria-label="Tunnel">
      <h2 className="text-heading-3">Tunnel</h2>
      {status.state === 'running' ? (
        <ServerTunnelStatus />
      ) : (
        <p className="text-body-2">{NO_TUNNEL_MESSAGE[status.state]}</p>
      )}
    </section>
  </>
)

/**
 * The `/settings/server` page: the Wildflower server's state, why it last
 * stopped and the error it stopped with, whether notifications are on, and,
 * while it runs, the tunnel's status and public host.
 *
 * @remarks
 * Renders the host's latest status snapshot and nothing else; before the first
 * one arrives it says it is waiting. Restart is offered in every state. The
 * Tauri entry contributes the Settings row that links here.
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
