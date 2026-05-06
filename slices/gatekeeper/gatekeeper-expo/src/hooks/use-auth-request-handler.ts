import { useRouter } from 'expo-router'
import { addAuthRequestListener, type PendingAuth } from 'gatekeeper-core/contexts'
import { useEffect } from 'react'

/**
 * Watches for incoming OAuth authorization requests from the server and
 * navigates to the native authorize-modal when one arrives.
 * Should be called once inside a component that has access to the router
 * (i.e., inside the Stack navigator).
 */
function useAuthRequestHandler(): void {
  const router = useRouter()

  useEffect(() => {
    const unsubscribe = addAuthRequestListener((auth: PendingAuth) => {
      router.navigate({
        pathname: '/authorization_request/[id]',
        params: { id: auth.code },
      })
    })

    return unsubscribe
  }, [router])
}

export { useAuthRequestHandler }
