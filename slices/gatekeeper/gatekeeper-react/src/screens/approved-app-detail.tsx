import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, type JSX } from 'react'
import { Await, useParams } from 'react-router'
import { AsyncErrorView, pageLayoutStyles, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect } from '../gatekeeper-client.tsx'
import styles from './approved-app-detail.module.css'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

const ApprovedAppDetailScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()

  const grantEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['access-management'].GetGrant({ path: { id } })
      ),
    [id]
  )

  const grantPromise = useGatekeeperEffect(grantEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={grantPromise} errorElement={<AsyncErrorView title="Not Found" />}>
        {(grant: Grant) => (
          <div className={pageLayoutStyles['page']}>
            <h1 className="text-heading-4">{grant.clientId}</h1>
            <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
          </div>
        )}
      </Await>
    </Suspense>
  )
}

export { ApprovedAppDetailScreen }
