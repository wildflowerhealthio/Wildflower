import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Remotes } from 'collector-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { defaultConfig } from 'fhir-r4-client-collector'
import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { useNavigate } from 'react-router'
import { Dialog, ItemList, Menu, pageLayoutStyles, type MenuItem } from 'react-tundraish'

import { formatInstant } from '../format-date.ts'
import { useRequestSniffableWebView } from '../runtime/use-request-sniffable-web-view.ts'
import { useCollectorEffectRunner } from '../use-collector-effect-runner.ts'
import accountList from '../styles/account-list.module.css'
import pageLayout from '../styles/page-layout.module.css'

type Remote = Schema.Schema.Type<typeof Remotes.RemoteSchema>

/**
 * Lists the remotes registered against `CollectorApi`. "Import Now"
 * sends `RequestSniffableWebView` to the host; on the embedded surface
 * the host opens a native sniffer modal. On standalone web the message
 * warns-and-drops in the bridge transport, which is fine — the menu
 * stays visible so a Wildflower-on-phone deployment over an HTTP
 * tunnel can still hand off to the device.
 */
const AccountListScreen = (): JSX.Element => {
  const navigate = useNavigate()
  const run = useCollectorEffectRunner()
  const requestSniffableWebView = useRequestSniffableWebView()
  const [remotes, setRemotes] = useState<readonly Remote[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const list = await run(
        Effect.flatMap(CollectorHttpApiClient, (c) => c['collector-remotes'].ListRemotes())
      )
      setRemotes(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
    // refresh closes over `run`; only re-fetch when the runner rotates
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  const deleteRemote = async (id: string): Promise<void> => {
    try {
      await run(
        Effect.flatMap(CollectorHttpApiClient, (c) =>
          c['collector-remotes'].DeleteRemote({ path: { id } })
        )
      )
      setConfirmDeleteId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const importNow = (remote: Remote): void => {
    const rootUrl = typeof remote.config['rootUrl'] === 'string' ? remote.config['rootUrl'] : ''
    if (rootUrl === '') return
    void requestSniffableWebView({ _tag: 'Uri', uri: rootUrl })
  }

  const remoteToDelete = remotes.find((r) => r.id === confirmDeleteId)

  return (
    <div className={pageLayoutStyles['page']}>
      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}

      {remotes.length > 0 ? (
        <ItemList
          title="Accounts"
          items={remotes.map((remote) => {
            const rootUrl =
              typeof remote.config['rootUrl'] === 'string' ? remote.config['rootUrl'] : ''
            return {
              id: remote.id,
              title: remote.name,
              badge: remote.config._tag.toUpperCase(),
              subtitle: (
                <span className={accountList['account-list-item__subtitles']}>
                  <span>{rootUrl}</span>
                  <span>Added {formatInstant(remote.addedAt)}</span>
                </span>
              ),
              onClick: () => {
                void navigate(`/collector/account?accountId=${encodeURIComponent(remote.id)}`)
              },
              actions: (
                <Menu
                  label={`Actions for ${remote.name}`}
                  items={
                    [
                      {
                        id: 'edit',
                        label: 'Edit',
                        onSelect: () => {
                          void navigate(
                            `/collector/account?accountId=${encodeURIComponent(remote.id)}`
                          )
                        },
                      },
                      {
                        id: 'import',
                        label: 'Import Now',
                        onSelect: () => {
                          importNow(remote)
                        },
                      },
                      {
                        id: 'delete',
                        label: 'Delete',
                        destructive: true,
                        onSelect: () => {
                          setConfirmDeleteId(remote.id)
                        },
                      },
                    ] as readonly MenuItem[]
                  }
                />
              ),
            }
          })}
        />
      ) : null}

      <ItemList
        title="Connect Accounts From"
        items={[
          {
            id: 'demo-fhir',
            title: 'Demo FHIR Server',
            subtitle: defaultConfig.rootUrl,
            onClick: () => {
              void navigate(
                `/collector/account?prefillName=${encodeURIComponent('Demo FHIR Server')}&prefillRootUrl=${encodeURIComponent(defaultConfig.rootUrl)}&prefillPatientId=${encodeURIComponent(defaultConfig.patientId)}`
              )
            },
          },
          {
            id: 'rexall-pharmacy',
            title: 'Rexall Pharmacy',
            subtitle: 'Prescription and pharmacy records',
            badge: 'Coming Soon',
            disabled: true,
            onClick: (): void => undefined,
          },
        ]}
      />

      {remotes.length === 0 ? (
        <p className={cn(accountList['account-list__empty'], 'text-body-3')}>
          No accounts connected yet. Choose a source above to get started.
        </p>
      ) : null}

      <Dialog
        open={remoteToDelete !== undefined}
        onClose={() => {
          setConfirmDeleteId(null)
        }}
        title="Delete Account"
      >
        <p className="text-body-2">
          Are you sure you want to delete &quot;{remoteToDelete?.name}&quot;?
        </p>
        <div className={pageLayout['button-row']}>
          <button
            type="button"
            className="button-2 filled accent-red"
            onClick={() => {
              if (remoteToDelete !== undefined) void deleteRemote(remoteToDelete.id)
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="button-2 outline"
            onClick={() => {
              setConfirmDeleteId(null)
            }}
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  )
}

export { AccountListScreen }
