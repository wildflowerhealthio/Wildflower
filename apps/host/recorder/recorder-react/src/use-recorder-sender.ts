import { useContext } from 'react'

import { RecorderSenderContext, type RecorderSender } from './recorder-sender-context.ts'

/**
 * Returns the `RecorderBridge` Web→Host sender.
 *
 * @throws When no `<RecorderSenderProvider>` is in the tree; the app wraps
 *   the recorder page in one.
 */
const useRecorderSender = (): RecorderSender => {
  const sender = useContext(RecorderSenderContext)
  if (sender === null) {
    throw new Error('useRecorderSender must be used inside <RecorderSenderProvider>')
  }
  return sender
}

export { useRecorderSender }
