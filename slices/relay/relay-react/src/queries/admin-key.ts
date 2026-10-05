import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, Option } from 'effect'
import { AdminKeyStore, importAdminKey } from 'relay-core/key-store'

import { useRelayAdmin } from '../relay-admin-context.ts'
import { ADMIN_KEY_QUERY_KEY, RELAY_QUERY_KEY } from './keys.ts'

/** The stored admin key, if this browser has signed in. */
const useStoredAdminKeyQuery = (): UseQueryResult<Option.Option<CryptoKey>> => {
  const { run } = useRelayAdmin()
  return useQuery({
    queryKey: ADMIN_KEY_QUERY_KEY,
    queryFn: () => run(Effect.flatMap(AdminKeyStore, (store) => store.load)),
    // Only this screen changes the stored key, and it updates the cache when
    // it does.
    staleTime: Infinity,
  })
}

/**
 * Sign in with the pasted `WILDFLOWER_RELAY_ADMIN_KEY`: import it as a
 * non-extractable signing key and store that. The text itself is not kept: it
 * is the mutation's variables, which the mutation cache drops as soon as the
 * key form is gone rather than after the default five minutes.
 */
const useSignInMutation = (): UseMutationResult<CryptoKey, Error, string> => {
  const { run, setKeyRefused } = useRelayAdmin()
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (pasted) =>
      run(
        Effect.gen(function* () {
          const key = yield* importAdminKey(pasted)
          yield* Effect.flatMap(AdminKeyStore, (store) => store.save(key))
          return key
        })
      ),
    onSuccess: (key) => {
      setKeyRefused(false)
      queryClient.setQueryData(ADMIN_KEY_QUERY_KEY, Option.some(key))
    },
  })
}

/** Sign out: delete the stored key and everything read with it. */
const useSignOutMutation = (): UseMutationResult<void, Error, void> => {
  const { run } = useRelayAdmin()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => run(Effect.flatMap(AdminKeyStore, (store) => store.clear)),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: RELAY_QUERY_KEY })
      queryClient.setQueryData(ADMIN_KEY_QUERY_KEY, Option.none())
    },
  })
}

export { useSignInMutation, useSignOutMutation, useStoredAdminKeyQuery }
