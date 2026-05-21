import { createContext, type RefObject } from 'react'
import type { AppShellWebViewHandle } from './app-shell-webview.tsx'

interface AppShellContextValue {
  /**
   * Ref to the host shell's imperative handle. Bridge-expo slice
   * providers (e.g. `<CollectorBridgeExpo.HostProvider>`) deref this
   * to thread `postRawMessage` into their flows.
   */
  readonly shellRef: RefObject<AppShellWebViewHandle | null>
}

/**
 * Shared context that exposes the host shell's imperative ref to
 * subtree consumers. Refs can't travel through expo-router params; the
 * context lets a modal route get at the shell's outbound handle without
 * prop drilling through the router layer.
 */
const AppShellContext = createContext<AppShellContextValue | null>(null)

export { AppShellContext }
export type { AppShellContextValue }
