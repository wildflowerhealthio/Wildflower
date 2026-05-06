import { queryDb } from '@livestore/livestore'
import { useQuery } from '@livestore/react'
import { AuthorizationRequests, type AuthorizationRequestRow } from 'gatekeeper-core/livestore'
import { useEffect, useRef } from 'react'

const pendingOAuthCodeRequests$ = queryDb(
  AuthorizationRequests.table.where({ status: 'pending', grantType: 'authorization_code' }),
  { label: 'pendingOAuthCodeRequests' }
)

/**
 * Subscribes to the LiveStore for new pending OAuth code-flow
 * authorization requests and invokes `onPending` once for each row the
 * first time it appears as pending. Lets the host app navigate to its
 * consent screen when a request arrives, without re-firing for rows
 * that were already known.
 */
function useAuthRequestHandler(onPending: (row: AuthorizationRequestRow) => void): void {
  const rows = useQuery(pendingOAuthCodeRequests$)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    for (const row of rows) {
      if (!seen.current.has(row.id)) {
        seen.current.add(row.id)
        onPending(row)
      }
    }
  }, [rows, onPending])
}

export { useAuthRequestHandler }
