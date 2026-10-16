import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConfirmDialog, ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useId, useState } from 'react'

import { failureText } from '../../../../failure-text.ts'
import { useRemoveServer } from '../../../../queries.ts'
import { useRunHostCommand } from '../../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'
import styles from './-destructive-actions.module.css'

/**
 * The server page's Destructive actions tab,
 * `/servers/$domain/destructive-actions`: the server's removal, said in full
 * under its heading, behind a confirm that asks for its domain to be typed;
 * once removed, the page returns to the list.
 */
const DestructiveActionsTab = (): JSX.Element => {
  const server = useListedServer()
  const headingId = useId()
  const navigate = useNavigate()
  const removeServer = useRemoveServer(useRunHostCommand(), () => {
    void navigate({ to: '/' })
  })
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  return (
    <section className={styles['destructive-actions']} aria-labelledby={headingId}>
      <h3 id={headingId} className={`text-label-3 ${styles['destructive-actions__title']}`}>
        Destructive actions
      </h3>
      <p className={`text-body-3 ${styles['destructive-actions__note']}`}>
        Remove stops this server and deletes it from this device, with its databases and
        certificates. Apps can no longer reach it at this address. It can't be undone.
      </p>
      <ErrorBanner error={removeServer.error === null ? null : failureText(removeServer.error)} />
      <button
        type="button"
        className={`button-2 outline accent-red ${styles['destructive-actions__remove']}`}
        onClick={() => {
          setConfirmingRemoval(true)
        }}
      >
        Remove
      </button>
      <ConfirmDialog
        open={confirmingRemoval}
        title={`Remove ${server.domain}?`}
        confirmLabel="Remove"
        destructive
        pending={removeServer.isPending}
        confirmText={server.domain}
        onConfirm={() => {
          removeServer.mutate(
            { domain: server.domain },
            {
              onSettled: () => {
                setConfirmingRemoval(false)
              },
            }
          )
        }}
        onCancel={() => {
          setConfirmingRemoval(false)
        }}
      >
        This stops the server and deletes it from this device, with its databases and certificates.
        It can't be undone.
      </ConfirmDialog>
    </section>
  )
}

export const Route = createFileRoute('/_servers/servers/$domain/destructive-actions')({
  component: DestructiveActionsTab,
})
