import { addNotificationResponseReceivedListener } from 'expo-notifications'
import { useEffect } from 'react'

type NotificationTap = {
  readonly id: string
  readonly action: string
}

/**
 * Subscribes to expo-notifications taps and invokes `onTap` with the
 * embedded `data.id` and the chosen `actionIdentifier`. Lets the host
 * app route the tap to the appropriate consent screen — there's no
 * one-tap approve, since approving an OAuth/device request needs
 * scope selection that only the consent screen can collect.
 */
function useNotificationTapHandler(onTap: (tap: NotificationTap) => void): void {
  useEffect(() => {
    const sub = addNotificationResponseReceivedListener((response) => {
      const id = response.notification.request.content.data?.id
      if (typeof id !== 'string') return
      onTap({ id, action: response.actionIdentifier })
    })
    return (): void => sub.remove()
  }, [onTap])
}

export { useNotificationTapHandler }
export type { NotificationTap }
