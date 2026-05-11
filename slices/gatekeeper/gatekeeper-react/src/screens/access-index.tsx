import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'

import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn, useEffectTs } from 'react-kitchen-sink'
import { Await, useNavigate } from 'react-router'
import { ItemList, Menu, type MenuItem } from 'react-tundraish'

import type { GatekeeperClient } from '../client/gatekeeper-client.ts'
import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { RevokeGrantDialog } from '../components/RevokeGrantDialog.tsx'
import { formatInstant } from '../format-date.ts'
import { useGatekeeperClient } from '../use-gatekeeper-client.ts'
import pageLayout from '../styles/page-layout.module.css'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

const AccessIndexScreen = (): JSX.Element => {
  const client = useGatekeeperClient()
  const [refreshKey, setRefreshKey] = useState(0)

  const grantsEffect = useMemo(
    () => Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListGrants()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const grantsPromise = useEffectTs(grantsEffect, client.runtime)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={grantsPromise} errorElement={<AsyncErrorView />}>
        {(grants: readonly Grant[]) => (
          <AccessIndexBody
            client={client}
            grants={grants}
            onRevoked={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface AccessIndexBodyProps {
  readonly client: GatekeeperClient
  readonly grants: readonly Grant[]
  readonly onRevoked: () => void
}

const AccessIndexBody = ({ client, grants, onRevoked }: AccessIndexBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const revoke = async (id: string): Promise<void> => {
    try {
      await client.runPromise(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['access-management'].RevokeGrant({ path: { id } })
        )
      )
      setConfirmRevokeId(null)
      onRevoked()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const grantToRevoke = grants.find((g) => g.id === confirmRevokeId) ?? null

  return (
    <div className={pageLayout['page']}>
      {error !== null ? <p className={cn(pageLayout['error'], 'text-body-3')}>{error}</p> : null}

      <ItemList
        title="Requests"
        items={[
          {
            id: 'requests',
            title: 'HTTP Requests',
            subtitle: 'View incoming request history',
            onClick: () => {
              void navigate('/gatekeeper/requests')
            },
          },
        ]}
      />

      {grants.length > 0 ? (
        <ItemList
          title="Approved Apps"
          items={grants.map((grant) => ({
            id: grant.id,
            title: grant.clientId,
            subtitle: `${grant.scopes.join(', ')} · Granted ${formatInstant(grant.grantedAt)}`,
            onClick: () => {
              void navigate(`/gatekeeper/approved/${encodeURIComponent(grant.id)}`)
            },
            actions: (
              <Menu
                label={`Actions for ${grant.clientId}`}
                items={
                  [
                    {
                      id: 'revoke',
                      label: 'Revoke',
                      destructive: true,
                      onSelect: () => {
                        setConfirmRevokeId(grant.id)
                      },
                    },
                  ] as readonly MenuItem[]
                }
              />
            ),
          }))}
        />
      ) : null}

      <RevokeGrantDialog
        clientId={grantToRevoke?.clientId ?? null}
        onConfirm={() => {
          if (grantToRevoke !== null) void revoke(grantToRevoke.id)
        }}
        onCancel={() => {
          setConfirmRevokeId(null)
        }}
      />
    </div>
  )
}

export { AccessIndexScreen }
