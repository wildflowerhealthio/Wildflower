import type { Schema } from 'effect'
import type { GatekeeperAccess } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { Dialog, ItemList, Menu, type MenuItem } from 'react-tundraish'
import { runAuth } from '../client.ts'

type Grant = Schema.Schema.Type<typeof GatekeeperAccess.GrantSchema>

const formatDate = (value: { epochMillis: number } | Date | string): string => {
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : value instanceof Date
        ? value.getTime()
        : value.epochMillis
  return new Date(ms).toLocaleString()
}

const AccessIndexScreen = (): JSX.Element => {
  const navigate = useNavigate()
  const [grants, setGrants] = useState<readonly Grant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const list = await runAuth((c) => c['gatekeeper-access'].ListGrants())
      setGrants(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const revoke = async (id: string): Promise<void> => {
    try {
      await runAuth((c) => c['gatekeeper-access'].RevokeGrant({ path: { id } }))
      setConfirmRevokeId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const grantToRevoke = grants.find((g) => g.id === confirmRevokeId)

  return (
    <div className="gk-page">
      {error !== null ? <p className="gk-error text-body-3">{error}</p> : null}

      <ItemList
        title="Requests"
        items={[
          {
            id: 'requests',
            title: 'HTTP Requests',
            subtitle: 'View incoming request history',
            onClick: () => {
              void navigate('/requests')
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
            subtitle: `${grant.scopes.join(', ')} · Granted ${formatDate(grant.grantedAt)}`,
            onClick: () => {
              void navigate(`/approved/${encodeURIComponent(grant.id)}`)
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

      <Dialog
        open={grantToRevoke !== undefined}
        onClose={() => {
          setConfirmRevokeId(null)
        }}
        title="Revoke Access"
      >
        <p className="text-body-2">
          Are you sure you want to revoke access for &quot;{grantToRevoke?.clientId}&quot;?
        </p>
        <div className="gk-buttons">
          <button
            type="button"
            className="button-2 filled accent-red"
            onClick={() => {
              if (grantToRevoke !== undefined) void revoke(grantToRevoke.id)
            }}
          >
            Revoke
          </button>
          <button
            type="button"
            className="button-2 outline"
            onClick={() => {
              setConfirmRevokeId(null)
            }}
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  )
}

export { AccessIndexScreen }
