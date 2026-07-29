import { useContext } from 'react'

import { CollectorRegisterContext } from './collector-register-context.ts'
import type { CollectorRegister } from './http-collector-transport.ts'

/**
 * Returns the collector's register/unregister pair — the seam the sync
 * runner installs its per-run handler record through. Backed by the HTTP
 * transport's `/sniffer/events` WebSocket (a run's `register` connects the
 * stream; `unregister` closes it). Throws when no
 * `<CollectorHttpTransportProvider>` is in the tree.
 */
const useCollectorRegister = (): CollectorRegister => {
  const register = useContext(CollectorRegisterContext)
  if (register === null) {
    throw new Error('useCollectorRegister must be used inside <CollectorHttpTransportProvider>')
  }
  return register
}

export { useCollectorRegister }
