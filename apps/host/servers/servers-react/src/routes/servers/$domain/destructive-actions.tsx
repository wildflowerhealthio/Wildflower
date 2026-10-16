import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConfirmDialog, ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import { type JSX, useId, useState } from 'react'

import { failureText } from '../../../failure-text.ts'
import { useRemoveServer } from '../../../queries.ts'
import { useRunHostCommand } from '../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'
import styles from './-destructive-actions.module.css'

/** The removal's state and what it can do. */
interface ServerRemoval {
  /** Whether the confirm is open. */
  readonly confirming: boolean
  /** Whether a removal is in flight. */
  readonly isRemoving: boolean
  /** The host's refusal of the latest removal. */
  readonly failure: Option.Option<string>
  /** Opens the confirm. */
  readonly ask: () => void
  /** Closes the confirm without removing anything. */
  readonly cancel: () => void
  /** Removes the server, closing the confirm once the host answers. */
  readonly confirm: () => void
}

/**
 * Removing the server `domain`, behind a confirm: once the host has removed
 * it, the page returns to the server list.
 */
const useServerRemoval = (domain: string): ServerRemoval => {
  const navigate = useNavigate()
  const removeServer = useRemoveServer(useRunHostCommand(), () => {
    void navigate({ to: '/servers' })
  })
  const [confirming, setConfirming] = useState(false)
  return {
    confirming,
    isRemoving: removeServer.isPending,
    failure: Option.fromNullable(removeServer.error).pipe(Option.map(failureText)),
    ask: () => {
      setConfirming(true)
    },
    cancel: () => {
      setConfirming(false)
    },
    confirm: () => {
      removeServer.mutate(
        { domain },
        {
          onSettled: () => {
            setConfirming(false)
          },
        }
      )
    },
  }
}

/**
 * The server page's Destructive actions tab,
 * `/servers/$domain/destructive-actions`: the server's removal (see
 * {@link useServerRemoval}), said in full under its heading, behind a
 * confirm that asks for its domain to be typed.
 */
const DestructiveActionsTab = (): JSX.Element => {
  const server = useListedServer()
  const headingId = useId()
  const removal = useServerRemoval(server.domain)
  return (
    <section className={styles['destructive-actions']} aria-labelledby={headingId}>
      <h3 id={headingId} className={`text-label-3 ${styles['destructive-actions__title']}`}>
        Destructive actions
      </h3>
      <p className={`text-body-3 ${styles['destructive-actions__note']}`}>
        Remove stops this server and deletes it from this device, with its databases and
        certificates. Apps can no longer reach it at this address. It can't be undone.
      </p>
      <ErrorBanner error={Option.getOrNull(removal.failure)} />
      <button
        type="button"
        className={`button-2 outline accent-red ${styles['destructive-actions__remove']}`}
        onClick={removal.ask}
      >
        Remove
      </button>
      <ConfirmDialog
        open={removal.confirming}
        title={`Remove ${server.domain}?`}
        confirmLabel="Remove"
        destructive
        pending={removal.isRemoving}
        confirmText={server.domain}
        onConfirm={removal.confirm}
        onCancel={removal.cancel}
      >
        This stops the server and deletes it from this device, with its databases and certificates.
        It can't be undone.
      </ConfirmDialog>
    </section>
  )
}

export const Route = createFileRoute('/servers/$domain/destructive-actions')({
  component: DestructiveActionsTab,
})
