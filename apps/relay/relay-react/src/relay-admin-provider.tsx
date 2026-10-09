import { useQueryClient } from '@tanstack/react-query'
import { Effect, Option } from 'effect'
import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { AdminKeyStore } from 'relay-core-js/key-store'

import { ADMIN_KEY_QUERY_KEY, TUNNELS_QUERY_KEY } from './queries/keys.ts'
import {
  isRefusal,
  RelayAdminContext,
  runWith,
  type RelayAdminContextValue,
  type RelayAdminRuntime,
} from './relay-admin-context.ts'

interface RelayAdminProviderProps {
  readonly runtime: RelayAdminRuntime
  readonly children: ReactNode
}

/**
 * Runs the admin screen's effects on `runtime`. When the relay refuses the
 * stored key (`401`), the key is deleted and the screen falls back to the
 * key form, saying why. Sits inside a `QueryClientProvider`.
 */
const RelayAdminProvider = ({ runtime, children }: RelayAdminProviderProps): JSX.Element => {
  const queryClient = useQueryClient()
  const [keyRefused, setKeyRefused] = useState(false)
  const value = useMemo((): RelayAdminContextValue => {
    const run = runWith(runtime)
    const dropRefusedKey = async (): Promise<void> => {
      await run(Effect.flatMap(AdminKeyStore, (store) => store.clear))
      queryClient.removeQueries({ queryKey: TUNNELS_QUERY_KEY })
      queryClient.setQueryData(ADMIN_KEY_QUERY_KEY, Option.none())
      setKeyRefused(true)
    }
    return {
      run: (effect) =>
        run(effect).catch(async (error: unknown) => {
          if (isRefusal(error)) await dropRefusedKey()
          throw error
        }),
      keyRefused,
      setKeyRefused,
    }
  }, [runtime, queryClient, keyRefused])
  return <RelayAdminContext.Provider value={value}>{children}</RelayAdminContext.Provider>
}

export { RelayAdminProvider, type RelayAdminProviderProps }
