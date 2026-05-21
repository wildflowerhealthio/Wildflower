/* oxlint-disable react/only-export-components -- HostProvider is the only
   React component in this file; `useHost` and `useReceiverLayer` are hooks
   that share its private context. Splitting them out would force a
   cross-file import of the otherwise-private context just to satisfy
   fast-refresh's "only components" rule. */
import CollectorBridge from 'collector-fundamentals/bridge'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
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

/**
 * Private context exposing the host-side actions a
 * {@link useReceiverLayer}-built layer needs to call when the SPA fires
 * `RequestSniffableWebView` (and friends). Holds the `pendingSource`
 * state the modal route reads, plus the `postRawMessage` sink that
 * forwards raw sniffer-wire payloads from the modal back into the
 * SPA's `CollectorBridge` via the host shell.
 */
interface CollectorHostContextValue {
  readonly pendingSource: WebViewSource.Any | null
  readonly postRawMessage: (rawWire: string) => void
  readonly requestSniffableWebView: (source: WebViewSource.Any) => void
  readonly cancelSnifferRequest: (id: string) => void
  readonly sniffingComplete: () => void
  readonly open: (source: WebViewSource.Any) => void
}

const CollectorHostContext = createContext<CollectorHostContextValue | null>(null)

interface HostProviderProps {
  /**
   * Raw-wire sink into the embedded SPA's `CollectorBridge`. The host
   * shell typically reads its WebView handle here — e.g.
   * `(rawWire) => shellRef.current?.postRawMessage(rawWire)`.
   */
  readonly postRawMessage: (rawWire: string) => void
  /**
   * Path of the file-system route that hosts {@link CollectorModalRoute}.
   * Defaults to `'/collector-modal'`.
   */
  readonly modalPath?: string
  readonly children: ReactNode
}

const DEFAULT_MODAL_PATH = '/collector-modal' as const

/**
 * Owns the collector-side host state (`pendingSource`) and exposes
 * stable action callbacks via a private context. Wrap the app's
 * router Stack with this provider; render `{@link CollectorModalRoute}`
 * at `modalPath` and use {@link useReceiverLayer} inside the bridge-
 * transport composition to wire `CollectorBridge.Host`'s handlers.
 *
 * Each web→host tag has a corresponding action exposed through the
 * context. `requestSniffableWebView` advances the pending source +
 * pushes the modal route; the others are placeholder no-ops today,
 * mirroring the legacy inline behavior (host shell didn't wire
 * `onCancelSnifferRequest` / `onSniffingComplete` / `onOpen`).
 * Future consumers can read them from the context to drive the modal
 * imperatively.
 */
const HostProvider = ({
  postRawMessage,
  modalPath = DEFAULT_MODAL_PATH,
  children,
}: HostProviderProps): JSX.Element => {
  const router = useRouter()
  const [pendingSource, setPendingSource] = useState<WebViewSource.Any | null>(null)

  const requestSniffableWebView = useCallback(
    (source: WebViewSource.Any): void => {
      setPendingSource(source)
      router.push(modalPath)
    },
    [router, modalPath]
  )

  const cancelSnifferRequest = useCallback((_id: string): void => undefined, [])
  const sniffingComplete = useCallback((): void => undefined, [])
  const open = useCallback((_source: WebViewSource.Any): void => undefined, [])

  const value = useMemo<CollectorHostContextValue>(
    () => ({
      pendingSource,
      postRawMessage,
      requestSniffableWebView,
      cancelSnifferRequest,
      sniffingComplete,
      open,
    }),
    [
      pendingSource,
      postRawMessage,
      requestSniffableWebView,
      cancelSnifferRequest,
      sniffingComplete,
      open,
    ]
  )

  return <CollectorHostContext.Provider value={value}>{children}</CollectorHostContext.Provider>
}

/**
 * Read the collector host context. Throws when called outside a
 * {@link HostProvider} — that's the same fail-fast policy the rest
 * of the slice contexts use.
 */
const useHost = (): CollectorHostContextValue => {
  const ctx = useContext(CollectorHostContext)
  if (ctx === null) {
    throw new Error('useHost must be called under <CollectorBridgeExpo.HostProvider>')
  }
  return ctx
}

/**
 * Build the host-side `ReceiverLayer` for `CollectorBridge`, closing
 * over the actions exposed by {@link HostProvider}.
 *
 * Handler bodies:
 *
 *  - `RequestSniffableWebView` — defense-in-depth: rejects any
 *    `{ _tag: 'Uri' }` source whose URI isn't `http(s)://`. The bridge
 *    schema already pins `Uri` to `https://` only, so this branch
 *    only ever runs on a future schema relaxation; until then it's a
 *    belt-and-suspenders log. Otherwise dispatches to
 *    `requestSniffableWebView(source)`.
 *  - `CancelSnifferRequest` / `SniffingComplete` / `Open` — forward
 *    to the corresponding context callbacks (currently no-op).
 *  - `Click` — `Effect.void`. The injected sniffer handles
 *    `document.querySelector(...)?.click()` itself; the host's only
 *    job is the raw-wire forwarding consumers wire via `onRawMessage`.
 */
const useReceiverLayer = (): Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>> => {
  const { requestSniffableWebView, cancelSnifferRequest, sniffingComplete, open } = useHost()
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
            requestSniffableWebView(source)
          }),
        CancelSnifferRequest: ({ id }) =>
          Effect.sync(() => {
            cancelSnifferRequest(id)
          }),
        SniffingComplete: () =>
          Effect.sync(() => {
            sniffingComplete()
          }),
        Open: ({ source }) =>
          Effect.sync(() => {
            open(source)
          }),
        // `Click` has no typed callback — the injected sniffer
        // handles `document.querySelector(...)?.click()` itself, so
        // the host's only job is to forward the wire to the sniffer
        // WebView. Consumers wire that via `onRawMessage`.
        Click: () => Effect.void,
      }),
    [requestSniffableWebView, cancelSnifferRequest, sniffingComplete, open]
  )
}

export { CollectorModalRoute } from './screens/CollectorModalRoute.tsx'
export { HostProvider, useHost, useReceiverLayer }
export type { HostProviderProps }
