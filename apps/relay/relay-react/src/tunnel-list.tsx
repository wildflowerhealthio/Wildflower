import {
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  PageLoading,
  type ItemListItem,
} from '@wildflowerhealthio/react-tundraish'
import { DateTime, Option } from 'effect'
import { useState, type JSX } from 'react'

import { useDeleteTunnelMutation, useTunnelsQuery, type TunnelInfo } from './queries/index.ts'
import styles from './tunnel-list.module.css'

/** One row: the name, where visitors reach it, whose it is and since when. */
const tunnelRow = (tunnel: TunnelInfo, onDelete: (name: string) => void): ItemListItem => ({
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
    <button
      type="button"
      className="button-3 outline accent-red"
      aria-label={`Delete ${tunnel.name}`}
      onClick={() => {
        onDelete(tunnel.name)
      }}
    >
      Delete
    </button>
  ),
})

/** Every tunnel on the relay, each with a confirmed delete. */
const TunnelList = (): JSX.Element => {
  const tunnels = useTunnelsQuery()
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
      <ErrorBanner error={remove.error} />
      {tunnels.data.length === 0 ? (
        <p className="text-body-2">No tunnels yet.</p>
      ) : (
        <ItemList
          items={tunnels.data.map((tunnel) =>
            tunnelRow(tunnel, (name) => {
              remove.reset()
              setConfirming(Option.some(name))
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
              Delete <strong>{name}</strong>? The relay stops serving it at once, and its token
              stops working.
            </span>
          )),
          Option.getOrNull
        )}
      </ConfirmDialog>
    </section>
  )
}

export { TunnelList }
