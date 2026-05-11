import { useContext } from 'react'

import type { GatekeeperClient } from './client/gatekeeper-client.ts'
import { GatekeeperClientContext } from './gatekeeper-client-context.ts'

/**
 * Returns the current {@link GatekeeperClient} — authenticated when
 * mounted under `<AuthorizedAppShell>` (token attached as a Bearer
 * header), unauthenticated otherwise. Throws when no provider is in
 * the tree (the app's root `<GatekeeperClientProvider token={null}>`
 * provides the unauthenticated fallback).
 */
const useGatekeeperClient = (): GatekeeperClient => {
  const client = useContext(GatekeeperClientContext)
  if (client === null) {
    throw new Error('useGatekeeperClient must be used inside <GatekeeperClientProvider>')
  }
  return client
}

export { useGatekeeperClient }
