import { ErrorBanner, StatusBadge } from '@wildflowerhealthio/react-tundraish'
import { type ListedServer, RunPolicy } from '@wildflowerhealthio/servers-core-js'
import { Duration } from 'effect'
import { type JSX, useId, useState } from 'react'

import { useActionError } from '../../../../action-error.ts'
import { AuthorizationButton } from '../../../../authorization-button.tsx'
import { LaunchButton } from '../../../../launch-button.tsx'
import type { RunHostCommand } from '../../../../router-context.ts'
import { runPolicyText } from '../../../../run-policy-text.ts'
import { formatInstant, statusSummary } from '../../../../server-status-text.ts'
import { useNow } from '../../../../use-now.ts'
import styles from './-status-hero.module.css'

/** Where copying the domain to the clipboard stands. */
type CopyOutcome = 'idle' | 'copied' | 'refused'

/**
 * The top of a server's page: its domain, with Copy; its status, merged from
 * its run state and health; when its run started, while it runs; under
 * them, when it runs, in the words of the server card's run-policy picker,
 * which is where it changes; the latest failure of Launch or Authorization;
 * and Launch and Authorization.
 *
 * @remarks
 * Launch opens the server's launcher, or says why it can't when the status
 * row doesn't (see `LaunchButton`); Authorization opens the server's
 * Wildflower Authorization app (see `AuthorizationButton`); each runs the
 * hero's full width, Authorization under Launch. Disabled for what the
 * status shows, each is described by the status row. Their latest failure
 * shows across the hero, above them, until either starts again. The
 * clipboard needs a focused, secure page and may still refuse; the domain is
 * on screen to copy by hand either way, and the page says so. A live
 * `until` policy's time left ticks down each minute, as the picker's does.
 */
const StatusHero = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const status = statusSummary(server.status)
  const now = useNow(Duration.minutes(1), RunPolicy.deadlineOf(server.runPolicy))
  const statusId = useId()
  const { error, onActionStart, onError } = useActionError()
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome>('idle')
  const copyDomain = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(server.domain)
      setCopyOutcome('copied')
    } catch {
      setCopyOutcome('refused')
    }
  }
  return (
    <section className={styles['status-hero']} aria-label="Status">
      <div className={styles['status-hero__domain-row']}>
        <h2 className={styles['status-hero__domain']} title={server.domain}>
          {server.domain}
        </h2>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            void copyDomain()
          }}
        >
          {copyOutcome === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyOutcome === 'refused' ? (
        <p className={`text-body-3 ${styles['status-hero__note']}`} role="status">
          The clipboard refused. Select the domain to copy it by hand.
        </p>
      ) : null}
      <div id={statusId} className={styles['status-hero__status-row']}>
        <StatusBadge tone={status.tone} pulse={status.tone === 'success'}>
          {status.label}
        </StatusBadge>
        {server.status.runState === 'running' ? (
          <span className={`text-body-3 ${styles['status-hero__note']}`}>
            Since {formatInstant(server.status.runningSince)}
          </span>
        ) : null}
      </div>
      <p className={`text-body-3 ${styles['status-hero__note']}`}>
        {runPolicyText(server.runPolicy, now)}
      </p>
      <ErrorBanner error={error} />
      <LaunchButton
        server={server}
        runHostCommand={runHostCommand}
        statusDescriptionId={statusId}
        onActionStart={onActionStart}
        onError={onError}
      />
      <AuthorizationButton
        server={server}
        runHostCommand={runHostCommand}
        statusDescriptionId={statusId}
        onActionStart={onActionStart}
        onError={onError}
      />
    </section>
  )
}

export { StatusHero }
