import type { Schema } from 'effect'
import type { Dashboard } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { Dialog, ItemList, Menu, type MenuItem } from 'react-tundraish'
import { runAuth } from '../client.ts'
import { clearInitial, readInitial } from '../data/initial.ts'

type ApprovedApp = Schema.Schema.Type<typeof Dashboard.ApprovedAppSchema>

type InitialState = { readonly approvedApps: readonly ApprovedApp[] }

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
  const [apps, setApps] = useState<readonly ApprovedApp[]>(() => {
    const initial = readInitial<InitialState>()
    clearInitial()
    return initial?.approvedApps ?? []
  })
  const [error, setError] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const list = await runAuth((c) => c['auth-dashboard'].ListApprovedApps())
      setApps(list)
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
      await runAuth((c) => c['auth-dashboard'].RevokeApprovedApp({ path: { id } }))
      setConfirmRevokeId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const appToRevoke = apps.find((a) => a.id === confirmRevokeId)

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

      {apps.length > 0 ? (
        <ItemList
          title="Approved Apps"
          items={apps.map((app) => ({
            id: app.id,
            title: app.label,
            badge: app.type.toUpperCase(),
            subtitle: `${app.scopes.join(', ')} · Approved ${formatDate(app.approvedAt)}`,
            onClick: () => {
              void navigate(`/approved/${encodeURIComponent(app.id)}`)
            },
            actions: (
              <Menu
                label={`Actions for ${app.label}`}
                items={
                  [
                    {
                      id: 'revoke',
                      label: 'Revoke',
                      destructive: true,
                      onSelect: () => {
                        setConfirmRevokeId(app.id)
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
        open={appToRevoke !== undefined}
        onClose={() => {
          setConfirmRevokeId(null)
        }}
        title="Revoke Access"
      >
        <p className="text-body-2">
          Are you sure you want to revoke access for &quot;{appToRevoke?.label}&quot;?
        </p>
        <div className="gk-buttons">
          <button
            type="button"
            className="button-2 filled accent-red"
            onClick={() => {
              if (appToRevoke !== undefined) void revoke(appToRevoke.id)
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
