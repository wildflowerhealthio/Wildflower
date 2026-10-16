import { createFileRoute } from '@tanstack/react-router'
import { ItemList } from '@wildflowerhealthio/react-tundraish'
import { PendingConsent, ServerStatus } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import type { JSX } from 'react'

import { failureText } from '../../../failure-text.ts'
import { useOpenPendingConsent } from '../../../queries.ts'
import { type RunHostCommand, useRunHostCommand } from '../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'
import styles from './-access.module.css'

/**
 * The newest consent waiting on the server, `pendingConsent`: who asks, and
 * Open, which opens it at its page in a browser signed in as the Owner. The
 * host's refusal to open it, or the browser's failure, takes the row's text,
 * until Open is pressed again.
 */
const PendingRequest = ({
  domain,
  pendingConsent,
  runHostCommand,
}: {
  readonly domain: string
  readonly pendingConsent: PendingConsent.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const openPendingConsent = useOpenPendingConsent(runHostCommand)
  const open = (
    <button
      type="button"
      className="button-2 filled"
      disabled={openPendingConsent.isPending}
      onClick={() => {
        openPendingConsent.mutate({ domain })
      }}
    >
      Open
    </button>
  )
  const item = { id: 'pending-request', title: 'Pending request', actions: open } as const
  return (
    <ItemList
      title="Access"
      maxLines={3}
      items={[
        openPendingConsent.error === null
          ? { ...item, subtitle: `${pendingConsent.clientName} wants access.` }
          : { ...item, subtitle: failureText(openPendingConsent.error), tone: 'danger' },
      ]}
    />
  )
}

/**
 * The server page's Access tab, `/servers/$domain/access`: the newest
 * consent waiting on the server, or that none is.
 */
const ServerAccessTab = (): JSX.Element => {
  const server = useListedServer()
  const runHostCommand = useRunHostCommand()
  return ServerStatus.pendingConsentOf(server.status).pipe(
    Option.map((pendingConsent) => (
      <PendingRequest
        key={PendingConsent.keyOf(pendingConsent)}
        domain={server.domain}
        pendingConsent={pendingConsent}
        runHostCommand={runHostCommand}
      />
    )),
    Option.getOrElse(() => (
      <p className={`text-body-3 ${styles['access__note']}`}>No requests waiting.</p>
    ))
  )
}

export const Route = createFileRoute('/servers/$domain/access')({
  component: ServerAccessTab,
})
