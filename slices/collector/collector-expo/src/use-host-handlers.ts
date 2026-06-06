import type { LinkedSpanContext } from 'browser-sniffer-expo'
import type { CollectorBridge } from 'collector-fundamentals/bridge'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { useRouter } from 'expo-router'
import { useCallback, useMemo } from 'react'

import { useCollectorHost } from './collector-host-context.tsx'
import { useBrowserSnifferSender } from './message-sender-pipes.tsx'

/**
 * Build the host-side inbound handler record for `CollectorBridge`.
 *
 * Must be called under {@link CollectorHostProvider} —
 * `useCollectorHost` throws otherwise.
 *
 * Non-obvious handler wiring:
 *
 *  - `RequestSniffableWebView` runs a defense-in-depth `http(s)://`
 *    check on `{ _tag: 'Uri' }` sources even though the bridge wire
 *    schema already restricts them to `https://`. See the inline
 *    comment at the predicate for the rationale.
 *  - `Open` reuses `pendingSource` directly (without `router.push`)
 *    so the existing modal re-mounts its `<BrowserSnifferWebView>` at
 *    the fresh URL without remounting the entire route.
 *  - `Click` / `CancelSnifferRequest` are forwarded through the
 *    BrowserSniffer pipe rather than handled here, because the
 *    sniffer's typed `MessageSender` only exists after the modal
 *    screen mounts. The pipe suspends on the sender slot and
 *    warn-and-drops pre-mount.
 */
const useCollectorHostHandlers = (): MessageHandler.HandlersFor<
  (typeof CollectorBridge)['WebToHost']
> => {
  const { setPendingSource, setPendingLinkedSpan, modalPath } = useCollectorHost()
  const router = useRouter()
  const sendToSniffer = useBrowserSnifferSender()

  // `setPendingSource` / `setPendingLinkedSpan` and `router.push` must
  // commit in the same React batch — `CollectorModalRoute` reads
  // `pendingSource` on its first mount, and a render between the writes
  // would leave it null. React 18 auto-batches these synchronous writes.
  const pushModal = useCallback(
    (source: WebViewSource.Any, linkedSpan: LinkedSpanContext | undefined): void => {
      setPendingSource(source)
      setPendingLinkedSpan(linkedSpan ?? null)
      router.push(modalPath)
    },
    [router, modalPath, setPendingSource, setPendingLinkedSpan]
  )

  return useMemo(
    () => ({
      RequestSniffableWebView: ({ source, linkedSpan }) =>
        Effect.suspend(() => {
          // Defense-in-depth: refuse non-`http(s)://` URIs even
          // though the bridge schema already restricts `Uri` to
          // `https://`. Case-insensitive so a future schema
          // relaxation accepting mixed casing still passes this
          // guard.
          if (source._tag === 'Uri' && !/^https?:\/\//i.test(source.uri)) {
            return Effect.logWarning(
              'collector-expo: refusing non-http(s) RequestSniffableWebView URI'
            ).pipe(Effect.annotateLogs({ uri: source.uri }))
          }
          return Effect.sync(() => pushModal(source, linkedSpan))
        }),
      Open: ({ source }) => Effect.sync(() => setPendingSource(source)),
      SniffingComplete: () => Effect.sync(() => router.back()),
      Click: sendToSniffer,
      CancelSnifferRequest: sendToSniffer,
    }),
    // `router` and `setPendingSource` are captured directly by
    // `SniffingComplete` and `Open` (not transitively via `pushModal`),
    // so they must stay listed independently.
    [pushModal, setPendingSource, router, sendToSniffer]
  )
}

export { useCollectorHostHandlers }
