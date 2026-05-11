import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, type JSX } from 'react'
import { Await, useParams } from 'react-router'
import { useEffectTs } from 'telemetry-react'

import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { useGatekeeperClientLayer } from '../use-gatekeeper-client-layer.ts'
import pageLayout from '../styles/page-layout.module.css'
import styles from './approved-app-detail.module.css'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

const ApprovedAppDetailScreen = (): JSX.Element => {
  const layer = useGatekeeperClientLayer()
  const { id = '' } = useParams<{ id: string }>()

  const grantEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['access-management'].GetGrant({ path: { id } })
      ).pipe(Effect.provide(layer)),
    [layer, id]
  )

  const grantPromise = useEffectTs(grantEffect)

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
