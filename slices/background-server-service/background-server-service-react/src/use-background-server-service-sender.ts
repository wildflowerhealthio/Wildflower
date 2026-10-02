import { useContext } from 'react'

import {
  BackgroundServerServiceSenderContext,
  type BackgroundServerServiceSender,
} from './background-server-service-sender-context.ts'

/**
 * Returns the `BackgroundServerServiceBridge` Web→Host sender.
 *
 * @throws When no `<BackgroundServerServiceSenderProvider>` is in the tree —
 *   the app's `BackgroundServerServiceSenderForwarder` always provides one.
 */
const useBackgroundServerServiceSender = (): BackgroundServerServiceSender => {
  const sender = useContext(BackgroundServerServiceSenderContext)
  if (sender === null) {
    throw new Error(
      'useBackgroundServerServiceSender must be used inside <BackgroundServerServiceSenderProvider>'
    )
  }
  return sender
}

export { useBackgroundServerServiceSender }
