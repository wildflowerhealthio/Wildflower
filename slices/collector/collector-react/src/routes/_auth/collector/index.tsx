import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { descriptors, listSubtitleForConfig } from 'collector-registry/registry'
import { useState, type JSX } from 'react'
import { cn, unwrapCause } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  Dialog,
  ErrorBanner,
  ItemList,
  Menu,
  PageHeader,
  type MenuItem,
} from 'react-tundraish'

import { formatInstant } from '../../../format-date.ts'
import {
  remotesQueryOptions,
  useDeleteRemoteMutation,
  useRemotesQuery,
  type Remote,
} from '../../../queries/index.ts'
import { useSyncRunner } from '../../../runtime/use-sync-runner.ts'
import accountList from './account-list.module.css'
import pageLayout from './page-layout.module.css'

interface AccountListBodyProps {
  readonly remotes: readonly Remote[]
}

/**
 * Lists the remotes registered against `CollectorApi`. "Import Now"
 * starts a sync run, whose plan's leading `Open` asks the host to build the
 * sniffer webview; on the embedded surface the host opens a native sniffer
 * modal. On standalone web the message
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
  const { startImport } = useSyncRunner({
    onError: (e) => {
      // oxlint-disable-next-line no-console
      console.error('Error during import:', unwrapCause(e))
      setImportError(e instanceof Error ? e.message : String(e))
    },
  })

  // An import error is a plain string from the sync runner; a delete-mutation
  // error flows through `ErrorBanner`, which renders the permission surface for a
  // `403 InsufficientScope` and a plain message otherwise.
  const error = importError ?? deleteMutation.error

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
    setImportError(null)
    startImport(remote)
  }

  const remoteToDelete = remotes.find((r) => r.id === confirmDeleteId)

  return (
    <>
      <PageHeader title="Collector" />

      <ErrorBanner error={error} />

      {remotes.length > 0 ? (
        <ItemList
          title="Accounts"
          items={remotes.map((remote) => {
            const subtitle = listSubtitleForConfig(remote.config)
            return {
              id: remote.id,
              title: remote.name,
              badge: remote.config._tag.toUpperCase(),
              subtitle: (
                <span className={accountList['account-list-item__subtitles']}>
                  <span>{subtitle}</span>
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
        items={descriptors.map((descriptor) => ({
          id: descriptor.tag,
          title: descriptor.display.title,
          subtitle: descriptor.display.description,
          onClick: (): void => {
            void navigate({
              to: '/collector/account/new',
              search: { tag: descriptor.tag, prefill: {} },
            })
          },
        }))}
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
 * The `/_auth/collector/` accounts-list route. The `_auth` layout's
 * `beforeLoad` gates on the bearer token, so the loader can call
 * `ensureQueryData` directly — token is guaranteed by the time it
 * runs. Genuine read failures propagate to `errorComponent`.
 */
export const Route = createFileRoute('/_auth/collector/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(remotesQueryOptions(context.runAuthed)),
  component: AccountListScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Collector" />,
})
