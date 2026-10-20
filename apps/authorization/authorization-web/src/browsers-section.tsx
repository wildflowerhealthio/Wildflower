import { QueryErrorResetBoundary, useQueryErrorResetBoundary } from '@tanstack/react-query'
import { CatchBoundary, type ErrorComponentProps } from '@tanstack/react-router'
import {
  formatInstant,
  useBrowserSessionsQuery,
  useRevokeBrowserSessionMutation,
  type BrowserSession,
} from '@wildflowerhealthio/authorization-react'
import {
  AsyncErrorView,
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  Menu,
  type MenuItem,
} from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { JSX } from 'react'
import { Suspense, useState } from 'react'

/**
 * What a browser session's row is titled: the name a paired browser was
 * given, or for an unnamed same-device session, "Owner browser".
 */
const browserSessionTitle = (session: BrowserSession): string =>
  Option.fromNullable(session.name).pipe(
    Option.getOrElse(() =>
      Match.value(session.kind).pipe(
        Match.when('same_device', () => 'Owner browser'),
        Match.when('paired', () => 'Paired browser'),
        Match.exhaustive
      )
    )
  )

/** How a browser came to hold its session, as its row says it. */
const browserSessionKindLabel = (session: BrowserSession): string =>
  Match.value(session.kind).pipe(
    Match.when('same_device', () => 'Same device'),
    Match.when('paired', () => 'Paired'),
    Match.exhaustive
  )

/**
 * Wildflower Authorization's "Browsers" section, loaded on its own: it
 * suspends on the browser sessions and catches that query's failure (e.g. a
 * `403` for a session without `wildflower/BrowserSession.r`) in place, with a
 * Retry, so the rest of the page still renders.
 */
const BrowsersSection = (): JSX.Element => (
  <QueryErrorResetBoundary>
    <CatchBoundary getResetKey={() => 0} errorComponent={BrowsersLoadError}>
      <Suspense fallback={null}>
        <LoadedBrowsers />
      </Suspense>
    </CatchBoundary>
  </QueryErrorResetBoundary>
)

/** The section's failed load, with a Retry that reads the sessions again. */
const BrowsersLoadError = ({ error, reset }: ErrorComponentProps): JSX.Element => {
  const { reset: resetFailedQueries } = useQueryErrorResetBoundary()
  return (
    <AsyncErrorView
      error={error}
      title="Error Loading Browsers"
      retry={() => {
        // Clear the failed query's error first, so the remounted suspense
        // query fetches again instead of re-throwing it.
        resetFailedQueries()
        reset()
      }}
    />
  )
}

const LoadedBrowsers = (): JSX.Element | null => {
  const { data: browserSessions } = useBrowserSessionsQuery()
  return <BrowsersList browserSessions={browserSessions} />
}

interface BrowsersListProps {
  readonly browserSessions: readonly BrowserSession[]
}

/**
 * The Owner's "Browsers" list: every browser the server has signed in whose
 * session is live, the Owner's own and those the Owner approved, with its kind, when it signed in, when it expires and when
 * it was last seen, the one this page is signed in through marked "This
 * browser". Each row's Revoke (confirmed) ends the session and everything
 * minted under it; on this browser's row it signs this browser out, so the
 * page signs in again.
 *
 * One revoke at a time: while one is in flight every row's Revoke is held.
 * The dialog closes once the revoke settles either way, so a failure shows in
 * the error banner rather than behind the modal. The list only changes once
 * the server confirms, via the browsers-list invalidation.
 */
const BrowsersList = ({ browserSessions }: BrowsersListProps): JSX.Element => {
  const mutation = useRevokeBrowserSessionMutation()
  const [confirmRevokeSid, setConfirmRevokeSid] = useState<string | null>(null)
  const sessionToRevoke = browserSessions.find((session) => session.sid === confirmRevokeSid)

  // A revoke's failure still shows once the list is empty.
  if (browserSessions.length === 0) return <ErrorBanner error={mutation.error} />

  const revoke = (sid: string): void => {
    mutation.mutate(
      { sid },
      {
        onSettled: () => {
          setConfirmRevokeSid(null)
        },
      }
    )
  }

  const revokeItemFor = (session: BrowserSession): MenuItem =>
    mutation.isPending
      ? { id: 'revoke', label: 'Revoke', disabled: true }
      : {
          id: 'revoke',
          label: 'Revoke',
          destructive: true,
          onSelect: () => {
            setConfirmRevokeSid(session.sid)
          },
        }

  return (
    <>
      <ErrorBanner error={mutation.error} />
      <ItemList
        title="Browsers"
        items={browserSessions.map((session) => ({
          id: session.sid,
          title: browserSessionTitle(session),
          subtitle: `${browserSessionKindLabel(session)} · Signed in ${formatInstant(session.createdAt)} · Expires ${formatInstant(session.expiresAt)} · Last seen ${formatInstant(session.lastSeenAt)}`,
          ...(session.heldByCaller ? { badge: 'This browser' } : {}),
          actions: (
            <Menu
              label={`Actions for ${browserSessionTitle(session)}`}
              items={[revokeItemFor(session)]}
            />
          ),
        }))}
      />
      <ConfirmDialog
        open={sessionToRevoke !== undefined}
        title="Revoke Browser"
        confirmLabel="Revoke"
        destructive
        pending={mutation.isPending}
        onConfirm={() => {
          if (sessionToRevoke !== undefined) revoke(sessionToRevoke.sid)
        }}
        onCancel={() => {
          setConfirmRevokeSid(null)
        }}
      >
        {Option.fromNullable(sessionToRevoke).pipe(
          Option.map((session) =>
            session.heldByCaller
              ? 'Revoke this browser? It is signed out now, along with every app it signed in to.'
              : `Revoke "${browserSessionTitle(session)}"? It is signed out now, along with every app it signed in to.`
          ),
          Option.getOrNull
        )}
      </ConfirmDialog>
    </>
  )
}

export { BrowsersList, BrowsersSection }
export type { BrowsersListProps }
