import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'
import { cn } from 'kitchen-sink'
import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { useStream } from 'react-kitchen-sink'
import { Await, useParams } from 'react-router'

import { makeUnauthenticatedSession } from '../client.ts'
import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import pageLayout from '../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

/**
 * SPA route that replaces the previously server-rendered polling
 * page. Subscribes to `pollAuthorizationStatus(id)` from
 * `gatekeeper-core` — that stream owns the polling cadence,
 * transient retry, and "stop on terminal status" logic; this
 * screen just renders the latest emission. Suspense covers the
 * pre-first-emission gap; `<Await>`'s `errorElement` surfaces
 * stream failures (e.g. 404 / 500 after retries are exhausted).
 *
 * The screen is mounted outside `<GatekeeperAuthorizedRoutes>`
 * because `/oauth/authorize/:id` is cookie-driven (no bearer
 * token), so it builds its own unauthenticated session.
 */
const OAuthPollingScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const session = useMemo(() => makeUnauthenticatedSession(), [])
  const stream = useMemo(() => pollAuthorizationStatus(id), [id])
  const statusPromise = useStream(stream, session.runtime)

  return (
    <Suspense fallback={<PollingSpinner />}>
      <Await
        resolve={statusPromise}
        errorElement={
          <AsyncErrorView
            title="Authorization Error"
            className={styles['poll']}
            titleClassName={pageLayout['poll-declined']}
          />
        }
      >
        {(status: AuthorizationStatus) => <PollingResult status={status} />}
      </Await>
    </Suspense>
  )
}

interface PollingResultProps {
  readonly status: AuthorizationStatus
}

const PollingResult = ({ status }: PollingResultProps): JSX.Element => {
  // `useStream` re-resolves on every emission, so React renders
  // the latest status. The redirect side effect runs once when
  // the status reaches `approved`.
  useEffect(() => {
    if (status.status === 'approved') {
      window.location.replace(status.redirect)
    }
  }, [status])

  if (status.status === 'denied') {
    return (
      <div className={cn(pageLayout['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Request Declined</h1>
        <p className="text-body-2">The authorization request was declined.</p>
      </div>
    )
  }
  if (status.status === 'error') {
    return (
      <div className={cn(pageLayout['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Authorization Error</h1>
        <p className="text-body-2">{status.message}</p>
      </div>
    )
  }
  // Pending heartbeat or post-approved-pre-redirect — same UI.
  return <PollingSpinner />
}

const PollingSpinner = (): JSX.Element => (
  <div className={cn(pageLayout['page'], styles['poll'])}>
    <div className={styles['poll-spinner']} />
    <h1 className="text-heading-4">Waiting for Approval</h1>
    <p className="text-body-2">Please approve this request on your device.</p>
  </div>
)

export { OAuthPollingScreen }
