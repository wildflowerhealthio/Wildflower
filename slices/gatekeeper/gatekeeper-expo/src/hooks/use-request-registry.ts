import { addNotificationResponseReceivedListener } from 'expo-notifications'
import { resolveApproval, setRequestRegistryStore } from 'gatekeeper-core/contexts'
import { useEffect } from 'react'
import { useGatekeeperStore } from '../contexts/gatekeeper-store.tsx'

/**
 * React hook that connects the gatekeeper request registry to the current
 * LiveStore and sets up the notification response listener. Call this
 * once from within a `GatekeeperStoreProvider` so taps on approve/reject
 * notifications route through the registry and commit to the store.
 */
function useRequestRegistry(): void {
  const store = useGatekeeperStore()

  useEffect(() => {
    setRequestRegistryStore(store)
    return (): void => {
      setRequestRegistryStore(null)
    }
  }, [store])

  useEffect(() => {
    const sub = addNotificationResponseReceivedListener((response) => {
      const id = response.notification.request.content.data?.id
      if (typeof id !== 'string') return
      resolveApproval(id, response.actionIdentifier === 'approve')
    })
    return (): void => sub.remove()
  }, [])
}

export { useRequestRegistry }
