import { useParams } from '@tanstack/react-router'
import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'

import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Awaited, pageLayoutStyles } from 'react-tundraish'

import { useGatekeeperStream } from '../gatekeeper-client.tsx'
import pageLayout from '../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

/**
 * SPA route that subscribes to `pollAuthorizationStatus(id)` and renders
 * the latest emission. The polling endpoint is public — but the runner
 * pipes through the same `BearerToken` plumbing as authed routes (which
 * resolves to `null` here and adds no header).
 */
const OAuthPollingScreen = (): JSX.Element => {
  // `strict: false` returns the un-narrowed cross-route params union at
  // type-level; runtime shape is `Record<string, string>` produced by the
  // matched route's placeholders. The cast surfaces the `id` field for
  // screen-local use without registering the app's routeTree from this
  // slice.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above
  const { id = '' } = useParams({ strict: false }) as unknown as { readonly id?: string }
  const stream = useMemo(() => pollAuthorizationStatus(id), [id])
  const statusPromise = useGatekeeperStream(stream)

  return (
    <Suspense fallback={<PollingSpinner />}>
      <Awaited
        promise={statusPromise}
        resetKey={id}
        errorTitle="Authorization Error"
        errorClassName={styles['poll']}
        errorTitleClassName={pageLayout['poll-declined']}
      >
        {(status: AuthorizationStatus) => <PollingResult status={status} />}
      </Awaited>
    </Suspense>
  )
}

interface PollingResultProps {
  readonly status: AuthorizationStatus
}

const PollingResult = ({ status }: PollingResultProps): JSX.Element => {
  useEffect(() => {
    if (status.status === 'approved') {
      window.location.replace(status.redirect)
    }
  }, [status])

  if (status.status === 'denied') {
    return (
      <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Request Declined</h1>
        <p className="text-body-2">The authorization request was declined.</p>
      </div>
    )
  }
  if (status.status === 'error') {
    return (
      <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Authorization Error</h1>
        <p className="text-body-2">{status.message}</p>
      </div>
    )
  }
  // Pending heartbeat or post-approved-pre-redirect — same spinner.
  return <PollingSpinner />
}

const PollingSpinner = (): JSX.Element => (
  <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
    <div className={styles['poll-spinner']} />
    <h1 className="text-heading-4">Waiting for Approval</h1>
    <p className="text-body-2">Please approve this request on your device.</p>
  </div>
)

export { OAuthPollingScreen }
