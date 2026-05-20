import type { WebViewSource } from 'collector-fundamentals/model'
import { createContext, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AppShellWebViewHandle } from './app-shell-webview.tsx'

interface AppShellContextValue {
  /**
   * Ref to the host shell's imperative handle. Modal screens use
   * `current.postRawCollectorMessage` to forward sniffer events back
   * into the SPA's `CollectorBridge`.
   */
  readonly shellRef: RefObject<AppShellWebViewHandle | null>
  /**
   * Most recent `RequestSniffableWebView` source the SPA emitted. The
   * modal screen reads this to seed its initial sniffer page.
   */
  readonly pendingSource: WebViewSource.Any | null
  readonly setPendingSource: Dispatch<SetStateAction<WebViewSource.Any | null>>
}

/**
 * Shared context bridging the persistent shell (mounted at the app
 * root) and the modal route. Refs and host-side state can't travel
 * through expo-router params; this context is how the modal sees the
 * shell's outbound message handle without lifting all of run-sync's
 * state up into the router layer.
 */
const AppShellContext = createContext<AppShellContextValue | null>(null)

export { AppShellContext }
export type { AppShellContextValue }
