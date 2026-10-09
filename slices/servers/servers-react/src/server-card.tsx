import { Link } from '@tanstack/react-router'
import { Option } from 'effect'
import type { JSX } from 'react'
import { type ListedServer, ServerStatus } from 'servers-core'

import type { RunHostCommand } from './router-context.ts'
import { RunPolicyPicker } from './run-policy-picker.tsx'
import { lastStopText, statusNote, statusSummary } from './server-status-text.ts'
import styles from './server-card.module.css'

/**
 * One server's card in the base's list: its domain and a status dot; a
 * run-policy field that says when it runs, outlined in its status's tone,
 * over the native picker that changes it; the host's refusal of the latest
 * change; what its status says beyond running or stopped; why its latest
 * run stopped; and Launch and Edit.
 *
 * @remarks
 * The picker is disabled while a change is pending. Launch does nothing yet:
 * launching an app from the base isn't built. Edit opens the server's page,
 * `/servers/$domain`, where it is removed.
 */
const ServerCard = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const status = statusSummary(server.status)
  return (
    <li className={styles['server-card']} data-tone={status.tone} aria-label={server.domain}>
      <div className={styles['server-card__title']}>
        <span className={styles['server-card__domain']} title={server.domain}>
          {server.domain}
        </span>
        <span
          className={styles['server-card__dot']}
          role="img"
          aria-label={status.label}
          title={status.label}
        />
      </div>
      <RunPolicyPicker server={server} tone={status.tone} runHostCommand={runHostCommand} />
      {statusNote(server.status).pipe(
        Option.map((note) => (
          <p key="status-note" className={`text-body-3 ${styles['server-card__note']}`}>
            {note}
          </p>
        )),
        Option.getOrNull
      )}
      {ServerStatus.lastStopOf(server.status).pipe(
        Option.map((stop) => (
          <p key="last-stop" className={`text-body-3 ${styles['server-card__note']}`}>
            {lastStopText(stop)}
          </p>
        )),
        Option.getOrNull
      )}
      <div className={styles['server-card__actions']}>
        <button type="button" className={`button-2 filled ${styles['server-card__action']}`}>
          Launch
        </button>
        <Link
          to="/servers/$domain"
          params={{ domain: server.domain }}
          className={`button button-2 outline ${styles['server-card__action']}`}
        >
          Edit
        </Link>
      </div>
    </li>
  )
}

export { ServerCard }
