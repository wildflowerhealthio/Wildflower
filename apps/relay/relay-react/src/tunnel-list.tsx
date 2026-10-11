import {
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  PageLoading,
  type ItemListItem,
} from '@wildflowerhealthio/react-tundraish'
import { DateTime, Option } from 'effect'
import { useState, type JSX } from 'react'

import { IssuedClaimCodePanel } from './issued-claim-code-panel.tsx'
import {
  useDeleteTunnelMutation,
  useIssueClaimCodeMutation,
  useTunnelsQuery,
  type TunnelInfo,
} from './queries/index.ts'
import styles from './tunnel-list.module.css'

/** What a row's buttons do, by tunnel name. */
interface TunnelRowActions {
  readonly onIssueClaimCode: (name: string) => void
  /** A claim code is being issued; no other can be until it is. */
  readonly issuing: boolean
  readonly onDelete: (name: string) => void
}

/** One row: the name, where visitors reach it, whose it is and since when. */
const tunnelRow = (tunnel: TunnelInfo, actions: TunnelRowActions): ItemListItem => ({
  id: tunnel.name,
  title: tunnel.name,
  subtitle: (
    <span className={styles['tunnel-list__details']}>
      <span>{tunnel.public_host}</span>
      <span>{tunnel.email}</span>
    </span>
  ),
  meta: (
    <time dateTime={DateTime.formatIso(tunnel.created_at)}>
      Created {DateTime.formatIsoDateUtc(tunnel.created_at)}
    </time>
  ),
  actions: (
    <span className={styles['tunnel-list__actions']}>
      <button
        type="button"
        className="button-3 outline"
        aria-label={`Issue claim code for ${tunnel.name}`}
        disabled={actions.issuing}
        onClick={() => {
          actions.onIssueClaimCode(tunnel.name)
        }}
      >
        Issue claim code
      </button>
      <button
        type="button"
        className="button-3 outline accent-red"
        aria-label={`Delete ${tunnel.name}`}
        onClick={() => {
          actions.onDelete(tunnel.name)
        }}
      >
        Delete
      </button>
    </span>
  ),
})

/**
 * Every tunnel on the relay, each with a claim code to issue, shown once
 * above the list, and a confirmed delete.
 */
const TunnelList = (): JSX.Element => {
  const tunnels = useTunnelsQuery()
  const issue = useIssueClaimCodeMutation()
  const remove = useDeleteTunnelMutation()
  const [confirming, setConfirming] = useState(Option.none<string>())
  const close = (): void => {
    setConfirming(Option.none())
  }
  if (tunnels.isPending) return <PageLoading message="Loading tunnels…" />
  if (tunnels.isError) return <ErrorBanner error={tunnels.error} />
  return (
    <section className={styles['tunnel-list']}>
      <h2 className="text-heading-4">Tunnels</h2>
      <ErrorBanner error={issue.error} />
      {Option.all({
        issued: Option.fromNullable(issue.data),
        tunnelName: Option.fromNullable(issue.variables),
      }).pipe(
        Option.map(({ issued, tunnelName }) => (
          <IssuedClaimCodePanel
            key="issued-claim-code"
            tunnelName={tunnelName}
            issued={issued}
            onDone={() => {
              issue.reset()
            }}
          />
        )),
        Option.getOrNull
      )}
      <ErrorBanner error={remove.error} />
      {tunnels.data.length === 0 ? (
        <p className="text-body-2">No tunnels yet.</p>
      ) : (
        <ItemList
          items={tunnels.data.map((tunnel) =>
            tunnelRow(tunnel, {
              onIssueClaimCode: (name) => {
                issue.mutate(name)
              },
              issuing: issue.isPending,
              onDelete: (name) => {
                remove.reset()
                setConfirming(Option.some(name))
              },
            })
          )}
        />
      )}
      <ConfirmDialog
        open={Option.isSome(confirming)}
        title="Delete tunnel?"
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          Option.map(confirming, (name) => {
            remove.mutate(name, { onSettled: close })
          })
        }}
        onCancel={close}
      >
        {confirming.pipe(
          Option.map((name) => (
            <span key="question">
              Delete <strong>{name}</strong>? The relay stops serving it at once, and its token and
              claim code stop working.
            </span>
          )),
          Option.getOrNull
        )}
      </ConfirmDialog>
    </section>
  )
}

export { TunnelList }
