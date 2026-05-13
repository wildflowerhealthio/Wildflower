import { useContext } from 'react'

import { CollectorSenderContext, type CollectorSender } from './collector-sender-context.ts'

/**
 * Returns the CollectorBridge Web→Host sender. Throws when no
 * `<CollectorSenderProvider>` is in the tree (the app's
 * TransportProvider always wraps the collector routes in one).
 */
const useCollectorSender = (): CollectorSender => {
  const sender = useContext(CollectorSenderContext)
  if (sender === null) {
    throw new Error('useCollectorSender must be used inside <CollectorSenderProvider>')
  }
  return sender
}

export { useCollectorSender }
