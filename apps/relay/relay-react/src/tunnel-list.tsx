import {
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  PageLoading,
  type ItemListItem,
} from '@wildflowerhealthio/react-tundraish'
import { DateTime, Option } from 'effect'
import { useState, type JSX } from 'react'

import { IssuedCodePanel } from './issued-code-panel.tsx'
import {
  useDeleteTunnelMutation,
  useIssueClaimCodeMutation,
  useReissueTokenMutation,
  useTunnelsQuery,
  type TunnelInfo,
  type TunnelOutcome,
} from './queries/index.ts'
import { TunnelTokenPanel } from './tunnel-token-panel.tsx'
import styles from './tunnel-list.module.css'

/** What a row's buttons do, by tunnel name. */
interface TunnelRowActions {
  readonly onIssueClaimCode: (name: string) => void
  /** A claim code is being issued; no other can be until it is. */
  readonly issuing: boolean
  readonly onReissueToken: (name: string) => void
  readonly onDelete: (name: string) => void
}

/** What became of a tunnel's last connection, in words. */
const LAST_OUTCOME_WORDS: Readonly<Record<TunnelOutcome, string>> = {
  ok: 'Last connection reached the device',
  tunnel_down: 'Last connection refused: device offline',
  tunnel_busy: 'Last connection refused: device not taking connections',
  tunnel_closed: 'Last connection refused: closed by the tunnel',
  proxy_header_failed: 'Last connection refused: relay error',
}

/**
 * One row: the name, where visitors reach it, whose it is, what became of its
 * last connection and since when it exists.
 */
const tunnelRow = (tunnel: TunnelInfo, actions: TunnelRowActions): ItemListItem => ({
  id: tunnel.name,
  title: tunnel.name,
  subtitle: (
    <span className={styles['tunnel-list__details']}>
      <span>{tunnel.public_host}</span>
      <span>{tunnel.email}</span>
      <span>
        {Option.fromNullable(tunnel.last_outcome).pipe(
          Option.map((outcome) => LAST_OUTCOME_WORDS[outcome]),
          Option.getOrElse(() => 'No connections since the relay started')
        )}
      </span>
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
        className="button-3 outline"
        aria-label={`Reissue token for ${tunnel.name}`}
        onClick={() => {
          actions.onReissueToken(tunnel.name)
        }}
      >
        Reissue token
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
 * Every tunnel on the relay, each with a claim code to issue and a confirmed
 * token reissue, either shown once above the list, and a confirmed delete.
 */
const TunnelList = (): JSX.Element => {
  const tunnels = useTunnelsQuery()
  const issue = useIssueClaimCodeMutation()
  const reissue = useReissueTokenMutation()
  const remove = useDeleteTunnelMutation()
  const [confirmingReissue, setConfirmingReissue] = useState(Option.none<string>())
  const closeReissue = (): void => {
    setConfirmingReissue(Option.none())
  }
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
          <IssuedCodePanel
            key="issued-claim-code"
            title={`Claim code for ${tunnelName}`}
            issued={issued}
            recipient="the tunnel’s owner"
            onDone={() => {
              issue.reset()
            }}
          >
            Its device redeems it once for the tunnel’s name and token. Any code issued for this
            tunnel before it no longer works.
          </IssuedCodePanel>
        )),
        Option.getOrNull
      )}
      {Option.fromNullable(reissue.data).pipe(
        Option.map((reissued) => (
          <TunnelTokenPanel
            key="reissued-token"
            title={`New token for ${reissued.name}`}
            tunnel={reissued}
            onDone={() => {
              reissue.reset()
            }}
          />
        )),
        Option.getOrNull
      )}
      <ErrorBanner error={reissue.error} />
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
              onReissueToken: (name) => {
                reissue.reset()
                setConfirmingReissue(Option.some(name))
              },
              onDelete: (name) => {
                remove.reset()
                setConfirming(Option.some(name))
              },
            })
          )}
        />
      )}
      <ConfirmDialog
        open={Option.isSome(confirmingReissue)}
        title="Reissue token?"
        confirmLabel="Reissue token"
        destructive
        pending={reissue.isPending}
        onConfirm={() => {
          Option.map(confirmingReissue, (name) => {
            reissue.mutate(name, { onSettled: closeReissue })
          })
        }}
        onCancel={closeReissue}
      >
        {confirmingReissue.pipe(
          Option.map((name) => (
            <span key="question">
              Reissue the token for <strong>{name}</strong>? The current token stops working at
              once, and the device using it disconnects until it’s given the new one.
            </span>
          )),
          Option.getOrNull
        )}
      </ConfirmDialog>
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
