import { useEffect, useMemo, type JSX, type PropsWithChildren } from 'react'

import { makeGatekeeperClient } from './client/gatekeeper-client.ts'
import { GatekeeperClientContext } from './gatekeeper-client-context.ts'

type GatekeeperClientProviderProps = PropsWithChildren<{
  /**
   * Bearer token for authenticated calls, or `null` to provide an
   * unauthenticated client (public OAuth/device endpoints). The provider
   * memoises on `token`, so a rotation boots a fresh `ManagedRuntime`
   * and disposes the previous one on unmount.
   */
  readonly token: string | null
}>

/**
 * Provides a {@link GatekeeperClient} to descendants via
 * {@link GatekeeperClientContext}. The app wraps the entire tree with
 * `token={null}` for public routes; `<AuthorizedAppShell>` re-wraps
 * inside with the live token so authenticated screens see a
 * bearer-attached client without changing their hook calls.
 */
const GatekeeperClientProvider = ({
  token,
  children,
}: GatekeeperClientProviderProps): JSX.Element => {
  const client = useMemo(() => makeGatekeeperClient(token), [token])

  // Dispose the previous runtime when `token` rotates or the provider unmounts.
  useEffect(
    () => (): void => {
      void client.runtime.dispose()
    },
    [client]
  )

  return (
    <GatekeeperClientContext.Provider value={client}>{children}</GatekeeperClientContext.Provider>
  )
}

export { GatekeeperClientProvider }
export type { GatekeeperClientProviderProps }
