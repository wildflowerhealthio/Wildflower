/* oxlint-disable react/only-export-components -- `HostProvider` is
   the file's only component; `useCollectorHost` is its companion hook,
   and lifting the hook into a third file would force a cross-file
   import of the otherwise-private context. */
import type { WebViewSource } from 'collector-fundamentals/model'
import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from 'react'

import { BrowserSnifferPipeProvider, CollectorPipeProvider } from './message-sender-pipes.tsx'

/**
 * Private context exposing the navigation state the modal route reads
 * (`pendingSource`) and the dispatch callback the receiver layer's
 * `RequestSniffableWebView` / `Open` handlers fire. Outbound
 * `Click` / `CancelSnifferRequest` route through the BrowserSniffer
 * pipe instead — no ref state lives on this context.
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
   *
   * Must match the file-system route where you re-export
   * {@link CollectorModalRoute}; if you override the default, rename
   * your route file accordingly. Must be a static path constant —
   * never derived from an untrusted source (bridge message, URL
   * param) since it's fed straight into `router.push`.
   */
  readonly modalPath?: string
  readonly children: ReactNode
}

const DEFAULT_MODAL_PATH = '/collector-modal' as const

/**
 * Owns the collector-side `pendingSource` state and mounts the two
 * message-sender pipes (`BrowserSnifferPipeProvider` +
 * `CollectorPipeProvider`) so descendant trees can register their
 * typed senders.
 *
 * Wrap the app's router Stack with this provider, render the modal
 * route at `modalPath`, and use `useReceiverLayer` inside the
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
    <BrowserSnifferPipeProvider>
      <CollectorPipeProvider>
        <CollectorHostContext.Provider value={value}>{children}</CollectorHostContext.Provider>
      </CollectorPipeProvider>
    </BrowserSnifferPipeProvider>
  )
}

/**
 * Read the collector host context. Throws when called outside a
 * {@link HostProvider} — the same fail-fast policy the rest of the
 * slice contexts use.
 */
const useCollectorHost = (): CollectorHostContextValue => {
  const ctx = useContext(CollectorHostContext)
  if (ctx === null) {
    throw new Error('useCollectorHost must be called under <CollectorBridgeExpo.HostProvider>')
  }
  return ctx
}

export { HostProvider, useCollectorHost }
export type { CollectorHostContextValue, HostProviderProps }
