import { useNavigate } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'

import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  Awaited,
  ItemList,
  Menu,
  pageLayoutStyles,
  PageLoading,
  type MenuItem,
} from 'react-tundraish'

import { RevokeGrantDialog } from '../components/RevokeGrantDialog.tsx'
import { formatInstant } from '../format-date.ts'
import {
  useGatekeeperEffect,
  useGatekeeperEffectAction,
  type GatekeeperEffectAction,
} from '../gatekeeper-client.tsx'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

const AccessIndexScreen = (): JSX.Element => {
  const runGatekeeper = useGatekeeperEffectAction()
  const [refreshKey, setRefreshKey] = useState(0)

  const grantsEffect = useMemo(
    () => Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListGrants()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const grantsPromise = useGatekeeperEffect(grantsEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Awaited promise={grantsPromise} resetKey={refreshKey}>
        {(grants: readonly Grant[]) => (
          <AccessIndexBody
            runGatekeeper={runGatekeeper}
            grants={grants}
            onRevoked={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

interface AccessIndexBodyProps {
  readonly runGatekeeper: GatekeeperEffectAction
  readonly grants: readonly Grant[]
  readonly onRevoked: () => void
}

const AccessIndexBody = ({
  runGatekeeper,
  grants,
  onRevoked,
}: AccessIndexBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const revoke = async (id: string): Promise<void> => {
    try {
      await runGatekeeper(
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
    <div className={pageLayoutStyles['page']}>
      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}

      <ItemList
        title="Requests"
        items={[
          {
            id: 'requests',
            title: 'HTTP Requests',
            subtitle: 'View incoming request history',
            onClick: () => {
              void navigate({ to: '/settings/gatekeeper/requests' })
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
              void navigate({
                to: `/settings/gatekeeper/approved/${encodeURIComponent(grant.id)}`,
              })
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
