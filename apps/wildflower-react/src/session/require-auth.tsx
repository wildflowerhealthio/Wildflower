import { Effect } from 'effect'
import { NeedsAuthMessage } from 'gatekeeper-react'
import { useMemo, type JSX, type ReactNode } from 'react'
import { useAuthTokenSubscribable, useStreamWithDefault } from 'react-kitchen-sink'

/**
 * Gates its children on a live bearer token. Renders
 * `<NeedsAuthMessage>` (the RFC 8628 device flow) when no token is
 * present; otherwise renders `children`.
 *
 * The gatekeeper and collector client layers are the same on both sides
 * of this gate — they read the live token from `BearerToken` (a
 * Subscribable provided by `<AuthTokenProvider>` higher up). Public
 * routes get a `null` token; authenticated routes get the rotated value.
 * No provider re-mount is needed, so this is pure UI gating.
 */
const RequireAuth = ({ children }: { readonly children: ReactNode }): JSX.Element => {
  const subscribable = useAuthTokenSubscribable()
  // `.changes` is a getter that returns a fresh `Stream` per access;
  // memoizing keeps the ref stable so `useStreamWithDefault`'s effect
  // doesn't re-fire (and reset to `null`) on every parent re-render.
  const tokenStream = useMemo(() => subscribable.changes, [subscribable])
  const starterToken = useMemo(() => Effect.runSync(subscribable.get), [subscribable])
  const token = useStreamWithDefault(tokenStream, starterToken)
  if (token === null || token === '') return <NeedsAuthMessage />
  return <>{children}</>
}

export { RequireAuth }
