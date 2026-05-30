import { useRouteContext } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useEffect, useRef, type JSX } from 'react'

import type { RouterContext } from '../router-context.ts'
import { prefetchKeyRoutes } from './prefetch-key-routes.ts'
import { useBridgeTransport } from './transport-context.ts'

/**
 * Renders nothing. Mounted inside the gated `_auth` subtree so it runs
 * only after the `beforeLoad` auth gate has passed (token guaranteed).
 * On first mount it warms the startup route prefetches, then — once they
 * settle (success OR error; a warm failure must not block the WebView
 * reveal) — posts the `UIReady` nav-bridge message so the embedded host
 * hides its native splash / reveals the WebView.
 *
 * Standalone web wires a `StubTransportProvider`, whose `sendMessage` is
 * a no-op `Effect.void`, so the emit is harmless there — the prefetch
 * still warms the cache for first paint.
 *
 * @remarks
 * Emits once per mount via a ref guard: in React StrictMode the effect
 * fires twice, and `defaultPreload: 'intent'` can briefly toggle the
 * subtree, but the host treats `UIReady` as idempotent (hides an
 * already-hidden splash). The guard keeps a single emit per gate-pass.
 */
const UIReadyEmitter = (): JSX.Element | null => {
  const transport = useBridgeTransport()
  // The annotated `select` re-narrows the root context (which
  // `useRouteContext` widens to `any` when the host router isn't the
  // registered one) without a cast — same pattern slices use.
  const { queryClient, runAuthed } = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => ({
      queryClient: context.queryClient,
      runAuthed: context.runAuthed,
    }),
  })
  const emittedRef = useRef(false)

  useEffect(() => {
    if (emittedRef.current) return
    emittedRef.current = true
    // `prefetchQuery` resolves on success or error, so the chain always
    // settles; `sendMessage` returns an Effect — running it on a fork is
    // the canonical fire-and-forget bridge send from a sync callback.
    void prefetchKeyRoutes(queryClient, runAuthed).finally(() => {
      Effect.runFork(transport.sendMessage({ _tag: 'UIReady' }))
    })
  }, [transport, queryClient, runAuthed])

  return null
}

export { UIReadyEmitter }
