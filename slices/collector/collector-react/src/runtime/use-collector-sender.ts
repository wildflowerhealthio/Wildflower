import { useContext } from 'react'

import { CollectorSenderContext, type CollectorSender } from './collector-sender-context.ts'

/**
 * Returns the collector's Web→Host sender — since the Tauri→Axum migration,
 * the HTTP transport's `/sniffer` REST caller (see
 * `http-collector-transport.ts`). Throws when no
 * `<CollectorHttpTransportProvider>` is in the tree (the app mounts one around
 * the collector routes).
 */
const useCollectorSender = (): CollectorSender => {
  const sender = useContext(CollectorSenderContext)
  if (sender === null) {
    throw new Error('useCollectorSender must be used inside <CollectorHttpTransportProvider>')
  }
  return sender
}

export { useCollectorSender }
