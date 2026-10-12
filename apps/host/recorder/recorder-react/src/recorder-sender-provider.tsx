import type { JSX, ReactNode } from 'react'

import { RecorderSenderContext, type RecorderSender } from './recorder-sender-context.ts'

interface RecorderSenderProviderProps {
  /**
   * Dispatches a `RecorderBridge` Web→Host message: the app's bridge
   * transport's `sendMessage`.
   */
  readonly send: RecorderSender
  readonly children: ReactNode
}

/**
 * Surfaces the app's bridge transport's `sendMessage` to the recorder page via
 * {@link RecorderSenderContext}; the recorder reads it through
 * {@link useRecorderSender}.
 */
const RecorderSenderProvider = ({ send, children }: RecorderSenderProviderProps): JSX.Element => (
  <RecorderSenderContext.Provider value={send}>{children}</RecorderSenderContext.Provider>
)

export { RecorderSenderProvider }
export type { RecorderSenderProviderProps }
