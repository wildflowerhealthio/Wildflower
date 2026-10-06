import { useQuery } from '@tanstack/react-query'
import { clientsQueryOptions, useRunAuthed as useGatekeeperRunAuthed } from 'gatekeeper-react'
import { useMemo } from 'react'

/**
 * Display names of the OAuth clients gatekeeper knows, by `clientId`. The log
 * stores only the id; the name is decoration, so the map is empty while the
 * client list loads or when it can't be read, and callers fall back to the id.
 */
const useClientNames = (): ReadonlyMap<string, string> => {
  const { data } = useQuery(clientsQueryOptions(useGatekeeperRunAuthed()))
  return useMemo(
    () => new Map((data ?? []).map((client) => [client.clientId, client.name] as const)),
    [data]
  )
}

export { useClientNames }
