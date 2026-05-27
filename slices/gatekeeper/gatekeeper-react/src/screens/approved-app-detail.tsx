import { useParams } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, pageLayoutStyles, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect } from '../gatekeeper-client.tsx'
import styles from './approved-app-detail.module.css'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

const ApprovedAppDetailScreen = (): JSX.Element => {
  // `strict: false`: see `oauth-polling.tsx` for the rationale.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `useParams({ strict: false })` returns the un-narrowed cross-route params union; this slice can't register the app's routeTree
  const { id = '' } = useParams({ strict: false }) as unknown as { readonly id?: string }

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
      <Awaited promise={grantPromise} resetKey={id} errorTitle="Not Found">
        {(grant: Grant) => (
          <div className={pageLayoutStyles['page']}>
            <h1 className="text-heading-4">{grant.clientId}</h1>
            <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
          </div>
        )}
      </Awaited>
    </Suspense>
  )
}

export { ApprovedAppDetailScreen }
