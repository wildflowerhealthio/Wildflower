import { queryDb } from '@livestore/livestore'
import { useQuery } from '@livestore/react'
import { AuthorizationRequests, type AuthorizationRequestRow } from 'gatekeeper-core/livestore'
import { useEffect, useRef } from 'react'

const pendingDeviceRequests$ = queryDb(
  AuthorizationRequests.table.where({ status: 'pending', grantType: 'device_code' }),
  { label: 'pendingDeviceRequests' }
)

/**
 * Subscribes to the LiveStore for new pending OAuth device-flow
 * (RFC 8628) authorization requests and invokes `onPending` once for
 * each row the first time it appears as pending. Device-flow rows
 * carry a `userCode` the host app should route to its device-consent
 * screen.
 */
function useDeviceAuthRequestHandler(onPending: (row: AuthorizationRequestRow) => void): void {
  const rows = useQuery(pendingDeviceRequests$)
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

export { useDeviceAuthRequestHandler }
