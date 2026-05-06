import { useRouter } from 'expo-router'
import { addPinAuthListener, type PendingPinAuth } from 'gatekeeper-core/contexts'
import { useEffect } from 'react'

/**
 * Watches for incoming PIN-based auth requests from the server and
 * navigates to the native pin-authorize-modal when one arrives.
 * Should be called once inside a component that has access to the router
 * (i.e., inside the Stack navigator).
 */
function usePinAuthHandler(): void {
  const router = useRouter()

  useEffect(() => {
    const unsubscribe = addPinAuthListener((auth: PendingPinAuth) => {
      router.navigate({
        pathname: '/authorization_request/[id]',
        params: { id: auth.id },
      })
    })

    return unsubscribe
  }, [router])
}

export { usePinAuthHandler }
