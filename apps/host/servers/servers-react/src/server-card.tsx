import { Link } from '@tanstack/react-router'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { type ListedServer, ServerStatus } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import { type JSX, useId } from 'react'

import { useActionError } from './action-error.ts'
import { AuthorizationButton } from './authorization-button.tsx'
import { LaunchButton } from './launch-button.tsx'
import type { RunHostCommand } from './router-context.ts'
import { RunPolicyPicker } from './run-policy-picker.tsx'
import { lastStopText, statusNote, statusSummary } from './server-status-text.ts'
import styles from './server-card.module.css'

/**
 * One server's card in the base's list: its domain and a status dot; a
 * run-policy field that says when it runs, outlined in its status's tone,
 * over the native picker that changes it; the host's refusal of the latest
 * change; what its status says beyond running or stopped; why its latest
 * run stopped; the latest failure of Launch or Authorization; and Launch,
 * Authorization and Edit.
 *
 * @remarks
 * The picker is disabled while a change is pending. Launch opens the
 * server's launcher, or says why it can't when the status note or the
 * latest run's stop doesn't (see `LaunchButton`); disabled for what the
 * status shows, it is described by whichever of the two is on the card,
 * never both. Authorization opens the server's Wildflower Authorization app
 * (see `AuthorizationButton`), described the same way while disabled. Both
 * open signed in as the server's Owner, and report their failures to the
 * card, which shows the latest across the card, above the buttons, until
 * either starts again. Edit opens the server's page, `/servers/$domain`,
 * where it is removed.
 */
const ServerCard = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const status = statusSummary(server.status)
  // The note and the latest run's stop are never on the card together.
  const statusId = useId()
  const { error, onActionStart, onError } = useActionError()
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
      {statusNote(server).pipe(
        Option.map((note) => (
          <p
            key="status-note"
            id={statusId}
            className={`text-body-3 ${styles['server-card__note']}`}
          >
            {note}
          </p>
        )),
        Option.getOrNull
      )}
      {ServerStatus.lastStopOf(server.status).pipe(
        Option.map((stop) => (
          <p key="last-stop" id={statusId} className={`text-body-3 ${styles['server-card__note']}`}>
            {lastStopText(stop)}
          </p>
        )),
        Option.getOrNull
      )}
      <ErrorBanner error={error} />
      <div className={styles['server-card__actions']}>
        <LaunchButton
          server={server}
          runHostCommand={runHostCommand}
          className={styles['server-card__action']}
          statusDescriptionId={statusId}
          onActionStart={onActionStart}
          onError={onError}
        />
        <AuthorizationButton
          server={server}
          className={styles['server-card__action']}
          statusDescriptionId={statusId}
          onActionStart={onActionStart}
          onError={onError}
        />
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
