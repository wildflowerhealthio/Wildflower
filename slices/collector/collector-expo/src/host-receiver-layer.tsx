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
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'

/**
 * Imperative surface the live `<CollectorModalScreen>` registers when
 * its underlying `<BrowserSnifferWebView>` mounts. The bridge's
 * `Click` / `CancelSnifferRequest` handlers reach into the ref to
 * drive the sniffer page. Null when no modal is mounted — handlers
 * silently drop, mirroring the bridge's "no peer attached" semantics.
 */
interface SnifferControl {
  readonly click: (querySelector: string) => void
  readonly cancelRequest: (id: string) => void
}

/**
 * Private context exposing the host-side actions a
 * {@link useReceiverLayer}-built layer needs to call when the SPA fires
 * `RequestSniffableWebView` (and friends). Holds the `pendingSource`
 * state the modal route reads, plus the `snifferControlRef` the active
 * modal registers so inbound `Click` / `CancelSnifferRequest` messages
 * from the SPA reach the sniffer page.
 */
interface CollectorHostContextValue {
  readonly pendingSource: WebViewSource.Any | null
  readonly snifferControlRef: RefObject<SnifferControl | null>
  readonly requestSniffableWebView: (source: WebViewSource.Any) => void
  readonly sniffingComplete: () => void
  readonly open: (source: WebViewSource.Any) => void
}

const CollectorHostContext = createContext<CollectorHostContextValue | null>(null)

interface HostProviderProps {
  /**
   * Path of the file-system route that hosts {@link CollectorModalRoute}.
   * Defaults to `'/collector-modal'`.
   */
  readonly modalPath?: string
  readonly children: ReactNode
}

const DEFAULT_MODAL_PATH = '/collector-modal' as const

/**
 * Owns the collector-side host state (`pendingSource` + the modal's
 * sniffer-control ref) and exposes stable action callbacks via a
 * private context. Wrap the app's router Stack with this provider;
 * render `{@link CollectorModalRoute}` at `modalPath` and use
 * {@link useReceiverLayer} inside the bridge-transport composition to
 * wire `CollectorBridge.Host`'s handlers.
 *
 * Web→host tags are dispatched via the context:
 *
 *  - `RequestSniffableWebView` advances the pending source + pushes the modal route.
 *  - `Click` / `CancelSnifferRequest` call into `snifferControlRef.current` —
 *    set by the live modal when its `<BrowserSnifferWebView>` mounts.
 *    Null-ref calls (no modal mounted) drop silently.
 *  - `SniffingComplete` / `Open` — placeholder no-ops; future
 *    consumers can drive the modal imperatively through these.
 */
const HostProvider = ({
  modalPath = DEFAULT_MODAL_PATH,
  children,
}: HostProviderProps): JSX.Element => {
  const router = useRouter()
  const [pendingSource, setPendingSource] = useState<WebViewSource.Any | null>(null)
  const snifferControlRef = useRef<SnifferControl | null>(null)

  const requestSniffableWebView = useCallback(
    (source: WebViewSource.Any): void => {
      setPendingSource(source)
      router.push(modalPath)
    },
    [router, modalPath]
  )

  const sniffingComplete = useCallback((): void => undefined, [])
  const open = useCallback((_source: WebViewSource.Any): void => undefined, [])

  const value = useMemo<CollectorHostContextValue>(
    () => ({
      pendingSource,
      snifferControlRef,
      requestSniffableWebView,
      sniffingComplete,
      open,
    }),
    [pendingSource, requestSniffableWebView, sniffingComplete, open]
  )

  return <CollectorHostContext.Provider value={value}>{children}</CollectorHostContext.Provider>
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
 *  - `CancelSnifferRequest` / `Click` — drive the active sniffer
 *    page through `snifferControlRef`. Null-ref (no modal mounted)
 *    drops silently — mirrors the bridge's "no peer attached"
 *    behavior for outbound sends.
 *  - `SniffingComplete` / `Open` — forward to the corresponding
 *    context callbacks (currently no-op).
 */
const useReceiverLayer = (): Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>> => {
  const { requestSniffableWebView, sniffingComplete, open, snifferControlRef } = useHost()
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
            snifferControlRef.current?.cancelRequest(id)
          }),
        SniffingComplete: () =>
          Effect.sync(() => {
            sniffingComplete()
          }),
        Open: ({ source }) =>
          Effect.sync(() => {
            open(source)
          }),
        Click: ({ querySelector }) =>
          Effect.sync(() => {
            snifferControlRef.current?.click(querySelector)
          }),
      }),
    [requestSniffableWebView, sniffingComplete, open, snifferControlRef]
  )
}

export { HostProvider, useHost, useReceiverLayer }
export type { HostProviderProps, SnifferControl }
