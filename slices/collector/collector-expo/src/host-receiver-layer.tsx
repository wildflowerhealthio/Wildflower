/* oxlint-disable react/only-export-components -- HostProvider is the only
   React component in this file; `useHost`, `useReceiverLayer`, and
   `useHostBinding` are hooks that share its private context. Splitting
   them out would force a cross-file import of the otherwise-private
   context just to satisfy fast-refresh's "only components" rule. */
import CollectorBridge from 'collector-fundamentals/bridge'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect, type Layer } from 'effect'
import type { HostBinding, MessageHandler } from 'effect-messaging-core'
import { useRouter } from 'expo-router'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react'

import {
  MessageSenderToBrowserSnifferProvider,
  MessageSenderToCollectorProvider,
  useMessageSenderToBrowserSniffer,
} from './message-sender-pipes.tsx'

/**
 * Private context exposing the navigation state the modal route
 * reads + the dispatch callback the {@link useReceiverLayer}
 * handlers fire when the SPA emits `RequestSniffableWebView` / `Open`
 * / `SniffingComplete`. Outbound `Click` / `CancelSnifferRequest`
 * route through {@link useMessageSenderToBrowserSniffer} instead —
 * no ref state is needed on this context.
 */
interface CollectorHostContextValue {
  readonly pendingSource: WebViewSource.Any | null
  readonly setPendingSource: (source: WebViewSource.Any | null) => void
  readonly modalPath: string
}

const CollectorHostContext = createContext<CollectorHostContextValue | null>(null)

interface HostProviderProps {
  /**
   * Path of the file-system route that hosts the collector modal.
   * Defaults to `'/collector-modal'`.
   */
  readonly modalPath?: string
  readonly children: ReactNode
}

const DEFAULT_MODAL_PATH = '/collector-modal' as const

/**
 * Owns the collector-side navigation state (`pendingSource`) and
 * mounts the two message-sender pipes:
 *
 *  - {@link MessageSenderToBrowserSnifferProvider} — the modal screen
 *    installs the `<BrowserSnifferWebView>`'s ref-exposed typed
 *    sender so the receiver layer's `Click` / `CancelSnifferRequest`
 *    handlers can dispatch into the live sniffer page.
 *  - {@link MessageSenderToCollectorProvider} — the app shell's
 *    `<BridgedWebView>` (mounting the Collector SPA) installs its
 *    ref-exposed typed sender so the modal screen can forward
 *    decoded sniffer events back through `CollectorBridge.hostToWeb`.
 *
 * Wrap the app's router Stack with this provider, render the modal
 * route at `modalPath`, and use {@link useReceiverLayer} inside the
 * bridge-transport composition to wire `CollectorBridge.Host`'s
 * handlers.
 */
const HostProvider = ({
  modalPath = DEFAULT_MODAL_PATH,
  children,
}: HostProviderProps): JSX.Element => {
  const [pendingSource, setPendingSource] = useState<WebViewSource.Any | null>(null)

  const value = useMemo<CollectorHostContextValue>(
    () => ({ pendingSource, setPendingSource, modalPath }),
    [pendingSource, modalPath]
  )

  return (
    <MessageSenderToBrowserSnifferProvider>
      <MessageSenderToCollectorProvider>
        <CollectorHostContext.Provider value={value}>{children}</CollectorHostContext.Provider>
      </MessageSenderToCollectorProvider>
    </MessageSenderToBrowserSnifferProvider>
  )
}

/**
 * Read the collector host context. Throws when called outside a
 * {@link HostProvider} — the same fail-fast policy the rest of the
 * slice contexts use.
 */
const useHost = (): CollectorHostContextValue => {
  const ctx = useContext(CollectorHostContext)
  if (ctx === null) {
    throw new Error('useHost must be called under <CollectorBridgeExpo.HostProvider>')
  }
  return ctx
}

/**
 * Build the host-side `ReceiverLayer` for `CollectorBridge`.
 *
 * Handler bodies:
 *
 *  - `RequestSniffableWebView` — defense-in-depth: rejects any
 *    `{ _tag: 'Uri' }` source whose URI isn't `http(s)://`. The
 *    bridge schema already pins `Uri` to `https://` only, so this
 *    branch only ever runs on a future schema relaxation. Otherwise
 *    sets `pendingSource` and pushes the modal route.
 *  - `Open` — sets `pendingSource` to the next source so the
 *    `<BrowserSnifferWebView>` re-mounts at a fresh URL without
 *    remounting the modal.
 *  - `SniffingComplete` — closes the modal via `router.back()`.
 *  - `Click` / `CancelSnifferRequest` — forwarded verbatim through
 *    {@link useMessageSenderToBrowserSniffer}. The sender suspends
 *    on `BrowserSnifferWebView`'s `__Ready` handshake and logs an
 *    error if no modal is mounted (pre-mount drop).
 */
const useReceiverLayer = (): Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>> => {
  const { setPendingSource, modalPath } = useHost()
  const router = useRouter()
  const sendToSniffer = useMessageSenderToBrowserSniffer()

  const pushModal = useCallback(
    (source: WebViewSource.Any): void => {
      setPendingSource(source)
      router.push(modalPath)
    },
    [router, modalPath, setPendingSource]
  )

  return useMemo(
    () =>
      CollectorBridge.Host.ReceiverLayer({
        RequestSniffableWebView: ({ source }) =>
          Effect.gen(function* () {
            if (
              source._tag === 'Uri' &&
              !source.uri.startsWith('https://') &&
              !source.uri.startsWith('http://')
            ) {
              yield* Effect.logWarning(
                `CollectorBridgeExpo: refusing non-http(s) RequestSniffableWebView URI ${source.uri}`
              )
              return
            }
            pushModal(source)
          }),
        Open: ({ source }) => Effect.sync(() => setPendingSource(source)),
        SniffingComplete: () => Effect.sync(() => router.back()),
        Click: (message) => sendToSniffer(message),
        CancelSnifferRequest: (message) => sendToSniffer(message),
      }),
    [pushModal, setPendingSource, router, sendToSniffer]
  )
}

/**
 * Host binding for the collector bridge. Wraps {@link useReceiverLayer}
 * (which reads from the surrounding {@link HostProvider} context) so
 * the binding shape matches stateless slices.
 */
const useHostBinding = (): HostBinding.HostBinding<typeof CollectorBridge> => {
  const receiverLayer = useReceiverLayer()
  return useMemo(() => ({ bridge: CollectorBridge, receiverLayer }), [receiverLayer])
}

export {
  useAsMessageSenderToBrowserSniffer,
  useAsMessageSenderToCollector,
  useMessageSenderToBrowserSniffer,
  useMessageSenderToCollector,
} from './message-sender-pipes.tsx'
export { HostProvider, useHost, useHostBinding, useReceiverLayer }
export type { HostProviderProps }
