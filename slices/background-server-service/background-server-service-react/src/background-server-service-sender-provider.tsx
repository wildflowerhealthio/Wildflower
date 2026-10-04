import type { JSX, ReactNode } from 'react'

import {
  BackgroundServerServiceSenderContext,
  type BackgroundServerServiceSender,
} from './background-server-service-sender-context.ts'

interface BackgroundServerServiceSenderProviderProps {
  /**
   * Dispatches a `BackgroundServerServiceBridge` Web→Host message — the app's
   * transport `sendMessage`.
   */
  readonly send: BackgroundServerServiceSender
  readonly children: ReactNode
}

/**
 * Surfaces the app's transport `sendMessage` to the banner and the
 * `/settings/server` page, which read it through
 * {@link useBackgroundServerServiceSender}.
 *
 * @remarks
 * Mounted inside the app's `<TransportContext.Provider>` by its
 * `BackgroundServerServiceSenderForwarder`.
 */
const BackgroundServerServiceSenderProvider = ({
  send,
  children,
}: BackgroundServerServiceSenderProviderProps): JSX.Element => (
  <BackgroundServerServiceSenderContext.Provider value={send}>
    {children}
  </BackgroundServerServiceSenderContext.Provider>
)

export { BackgroundServerServiceSenderProvider }
export type { BackgroundServerServiceSenderProviderProps }
