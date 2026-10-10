import { useQueryClient } from '@tanstack/react-query'

import { REQUEST_LOG_QUERY_KEY } from './keys.ts'

/**
 * Re-reads every request-log query: the callers summary, the newest refused
 * requests, and every filtered page of the table. The log is read on demand,
 * so this is how a screen picks up requests logged since its last read.
 */
const useRefreshRequestLog = (): (() => Promise<void>) => {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: REQUEST_LOG_QUERY_KEY })
}

export { useRefreshRequestLog }
