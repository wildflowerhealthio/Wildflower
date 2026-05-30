import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { defaultConfig } from 'fhir-r4-client-collector'
import { unknownErrorToString } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn, unwrapCause } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  Dialog,
  ItemList,
  Menu,
  pageLayoutStyles,
  type MenuItem,
} from 'react-tundraish'

import { formatInstant } from '../../../format-date.ts'
import {
  remotesQueryOptions,
  useDeleteRemoteMutation,
  useRemotesQuery,
  type Remote,
} from '../../../queries/index.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import { useSyncRunner } from '../../../runtime/use-sync-runner.ts'
import accountList from './account-list.module.css'
import pageLayout from './page-layout.module.css'

interface AccountListBodyProps {
  readonly remotes: readonly Remote[]
}

/**
 * Lists the remotes registered against `CollectorApi`. "Import Now"
 * sends `RequestSniffableWebView` to the host; on the embedded surface
 * the host opens a native sniffer modal. On standalone web the message
 * warns-and-drops in the bridge transport, which is fine — the menu
 * stays visible so a Wildflower-on-phone deployment over an HTTP
 * tunnel can still hand off to the device.
 *
 * The remotes list is read through `useRemotesQuery` (TanStack Query),
 * warmed by the route `loader`. Deleting a remote rides
 * `useDeleteRemoteMutation`, whose `invalidateQueries` refetches the list
 * — no manual `refresh()`.
 */
function AccountListBody({ remotes }: AccountListBodyProps): JSX.Element {
  const navigate = useNavigate()
  const deleteMutation = useDeleteRemoteMutation()
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [activeImportRemote, setActiveImportRemote] = useState<Remote | null>(null)
  useSyncRunner({
    remote: activeImportRemote,
    onError: (e) => {
      console.error('Error during import:', unwrapCause(e))
      setImportError(e instanceof Error ? e.message : String(e))
      setActiveImportRemote(null)
    },
  })

  const deleteError =
    deleteMutation.error === null ? null : unknownErrorToString(deleteMutation.error)
  const error = importError ?? deleteError

  const deleteRemote = (id: string): void => {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmDeleteId(null)
        },
      }
    )
  }

  const importNow = (remote: Remote): void => {
    const rootUrl = typeof remote.config['rootUrl'] === 'string' ? remote.config['rootUrl'] : ''
    if (rootUrl === '') return

    setImportError(null)
    setActiveImportRemote(remote)
  }

  const remoteToDelete = remotes.find((r) => r.id === confirmDeleteId)

  return (
    <>
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
                void navigate({ to: '/collector/account/$id', params: { id: remote.id } })
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
                          void navigate({
                            to: '/collector/account/$id',
                            params: { id: remote.id },
                          })
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
              void navigate({
                to: '/collector/account/new',
                search: {
                  prefillName: 'Demo FHIR Server',
                  prefillRootUrl: defaultConfig.rootUrl,
                  prefillPatientId: defaultConfig.patientId,
                },
              })
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
              if (remoteToDelete !== undefined) deleteRemote(remoteToDelete.id)
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
    </>
  )
}

function AccountListScreen(): JSX.Element {
  const { data: remotes } = useRemotesQuery()
  return <AccountListBody remotes={remotes} />
}

/**
 * The `/_auth/collector/` accounts-list route.
 *
 * The `_auth` gate is a React component (`RequireAuth`), not
 * `beforeLoad`, so the loader fires before auth. {@link ensureAuthedQuery}
 * skips the prefetch when the bearer token isn't ready yet (embedded first
 * paint, before `transport.flushed`) and lets the in-component
 * `useSuspenseQuery` — rendered only after `RequireAuth` passes — do the
 * real read. Genuine read failures propagate to `errorComponent`.
 */
export const Route = createFileRoute('/_auth/collector/')({
  loader: ({ context }) => ensureAuthedQuery(context, remotesQueryOptions(context.runAuthed)),
  component: AccountListScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Collector" />,
})
