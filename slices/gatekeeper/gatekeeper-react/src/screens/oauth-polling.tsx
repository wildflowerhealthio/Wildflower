import { Stream } from 'effect'
import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'

import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await, useParams } from 'react-router'
import { useStream } from 'telemetry-react'

import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { useGatekeeperClientLayer } from '../use-gatekeeper-client-layer.ts'
import pageLayout from '../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

/**
 * SPA route that subscribes to `pollAuthorizationStatus(id)` and renders the
 * latest emission. Mounted in the public-routes fragment, so the closest
 * `<GatekeeperClientProvider>` provides a `token=null` layer — exactly
 * what the unauthenticated polling endpoint needs.
 */
const OAuthPollingScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const layer = useGatekeeperClientLayer()
  const stream = useMemo(() => Stream.provideLayer(pollAuthorizationStatus(id), layer), [layer, id])
  const statusPromise = useStream(stream)

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
  // Pending heartbeat or post-approved-pre-redirect — same spinner.
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
