import type { JSX, ReactNode } from 'react'

import { AppsSenderContext, type AppsSender } from './apps-sender-context.ts'

interface AppsSenderProviderProps {
  /**
   * Function that dispatches an AppsBridge Web→Host message — typically
   * `transport.sendMessage` from the app's BridgeTransport.
   */
  readonly send: AppsSender
  readonly children: ReactNode
}

/**
 * Surfaces the app's `BridgeTransport.sendMessage` to apps-react
 * screens via {@link AppsSenderContext}. Mounted *inside* the app's
 * `<TransportContext.Provider>` so the transport is available; apps
 * screens read it via {@link useAppsSender}.
 */
const AppsSenderProvider = ({ send, children }: AppsSenderProviderProps): JSX.Element => (
  <AppsSenderContext.Provider value={send}>{children}</AppsSenderContext.Provider>
)

export { AppsSenderProvider }
export type { AppsSenderProviderProps }
