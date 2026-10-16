import { createFileRoute } from '@tanstack/react-router'
import { ItemList, type ItemListItem } from '@wildflowerhealthio/react-tundraish'
import {
  type ListedServer,
  PendingConsent,
  ServerStatus,
} from '@wildflowerhealthio/servers-core-js'
import { Equivalence, Option } from 'effect'
import { type JSX, useState } from 'react'

import {
  type AuthorizationAppOpening,
  useAuthorizationAppOpening,
} from '../../../authorization-app-opening.ts'
import { failureText } from '../../../failure-text.ts'
import { useOpenPendingConsent } from '../../../queries.ts'
import { useRunHostCommand } from '../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'

/** Opening the newest consent waiting on a server. */
interface PendingConsentOpening {
  /** The newest consent waiting on the server, `pendingConsent`. */
  readonly pendingConsent: Option.Option<PendingConsent.Type>
  /** Whether an open is in flight. */
  readonly isOpening: boolean
  /**
   * Why opening the consent waiting now failed: the host's refusal, or the
   * browser's failure, until Open is pressed again. A failure to open an
   * earlier consent isn't this one's.
   */
  readonly failure: Option.Option<string>
  /** Opens the consent waiting at its page in a browser signed in as the Owner. */
  readonly open: () => void
}

/** Opening the newest consent waiting on `server`. */
const usePendingConsentOpening = (server: ListedServer.Type): PendingConsentOpening => {
  const openPendingConsent = useOpenPendingConsent(useRunHostCommand())
  const pendingConsent = ServerStatus.pendingConsentOf(server.status)
  const pendingKey = Option.map(pendingConsent, PendingConsent.keyOf)
  const [openedKey, setOpenedKey] = useState<Option.Option<string>>(Option.none())
  const openedThisConsent =
    Option.isSome(pendingKey) && Option.getEquivalence(Equivalence.string)(openedKey, pendingKey)
  return {
    pendingConsent,
    isOpening: openPendingConsent.isPending,
    failure: openedThisConsent
      ? Option.fromNullable(openPendingConsent.error).pipe(Option.map(failureText))
      : Option.none(),
    open: () => {
      setOpenedKey(pendingKey)
      openPendingConsent.mutate({ domain: server.domain })
    },
  }
}

/**
 * The Pending request row: who asks, with Open, while a consent waits, the
 * failure to open it taking the row's text; and that none does otherwise.
 */
const pendingRequestItem = ({
  pendingConsent,
  isOpening,
  failure,
  open,
}: PendingConsentOpening): ItemListItem => {
  const item = { id: 'pending-request', title: 'Pending request' } as const
  return pendingConsent.pipe(
    Option.map(({ clientName }): ItemListItem => ({
      ...item,
      actions: (
        <button type="button" className="button-2 filled" disabled={isOpening} onClick={open}>
          Open
        </button>
      ),
      ...failure.pipe(
        Option.match({
          onNone: () => ({ subtitle: `${clientName} wants access.` }),
          onSome: (text) => ({ subtitle: text, tone: 'danger' as const }),
        })
      ),
    })),
    Option.getOrElse((): ItemListItem => ({ ...item, subtitle: 'No requests waiting.' }))
  )
}

/**
 * The Authorization app row: what the server's Wildflower Authorization app
 * holds, with Open, disabled while the host would refuse, the failure to
 * open it taking the row's text.
 */
const authorizationAppItem = ({
  unavailable,
  isOpening,
  failure,
  open,
}: AuthorizationAppOpening): ItemListItem => ({
  id: 'authorization-app',
  title: 'Authorization app',
  actions: (
    <button
      type="button"
      className="button-2 outline"
      disabled={unavailable || isOpening}
      aria-label="Open Authorization app"
      onClick={() => {
        open()
      }}
    >
      Open
    </button>
  ),
  ...failure.pipe(
    Option.match({
      onNone: () => ({ subtitle: 'Lists the apps and devices with access to this server.' }),
      onSome: (text) => ({ subtitle: text, tone: 'danger' as const }),
    })
  ),
})

/**
 * The server page's Access tab, `/servers/$domain/access`: the newest
 * consent waiting on the server, or that none is, and its Authorization app,
 * which holds the full list of what has access.
 */
const ServerAccessTab = (): JSX.Element => {
  const server = useListedServer()
  const pendingConsentOpening = usePendingConsentOpening(server)
  const authorizationAppOpening = useAuthorizationAppOpening(server)
  return (
    <ItemList
      title="Access"
      maxLines={3}
      items={[
        pendingRequestItem(pendingConsentOpening),
        authorizationAppItem(authorizationAppOpening),
      ]}
    />
  )
}

export const Route = createFileRoute('/servers/$domain/access')({
  component: ServerAccessTab,
})
