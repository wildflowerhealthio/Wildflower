import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, type JSX } from 'react'
import { useEffectTs } from 'react-kitchen-sink'
import { Await, useParams } from 'react-router'

import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { useGatekeeperClient } from '../use-gatekeeper-client.ts'
import pageLayout from '../styles/page-layout.module.css'
import styles from './approved-app-detail.module.css'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

/**
 * Suspense + `Await` pattern: the grant fetch is a single Effect run
 * through the session runtime, returning a stable `Promise` (via
 * `useEffectTs`). React's Suspense boundary handles the pending
 * state; `<Await>`'s `errorElement` + `useAsyncError()` handle
 * rejection — no manual `try`/`catch`, `cancelled` flag, or
 * `setError` needed.
 */
const ApprovedAppDetailScreen = (): JSX.Element => {
  const session = useGatekeeperClient()
  const { id = '' } = useParams<{ id: string }>()

  const grantEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['access-management'].GetGrant({ path: { id } })
      ),
    [id]
  )

  const grantPromise = useEffectTs(grantEffect, session.runtime)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={grantPromise} errorElement={<AsyncErrorView title="Not Found" />}>
        {(grant: Grant) => (
          <div className={pageLayout['page']}>
            <h1 className="text-heading-4">{grant.clientId}</h1>
            <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
          </div>
        )}
      </Await>
    </Suspense>
  )
}

export { ApprovedAppDetailScreen }
