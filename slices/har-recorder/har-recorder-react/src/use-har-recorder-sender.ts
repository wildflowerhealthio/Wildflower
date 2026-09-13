import { useContext } from 'react'

import { HarRecorderSenderContext, type HarRecorderSender } from './har-recorder-sender-context.ts'

/**
 * Returns the `HarRecorderBridge` Web→Host sender.
 *
 * @throws When no `<HarRecorderSenderProvider>` is in the tree — the app's
 *   `HarRecorderSenderForwarder` always wraps the recorder route in one.
 */
const useHarRecorderSender = (): HarRecorderSender => {
  const sender = useContext(HarRecorderSenderContext)
  if (sender === null) {
    throw new Error('useHarRecorderSender must be used inside <HarRecorderSenderProvider>')
  }
  return sender
}

export { useHarRecorderSender }
