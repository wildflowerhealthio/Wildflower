import { Effect, Either, Schema } from 'effect'
import { addNotificationResponseReceivedListener } from 'expo-notifications'
import { useEffect, useRef } from 'react'

type NotificationTap = {
  readonly id: string
  readonly action: string
}

const NotificationDataSchema = Schema.Struct({
  id: Schema.String,
})

const decodeNotificationData = Schema.decodeUnknownEither(NotificationDataSchema)

/**
 * Subscribes to expo-notifications taps and invokes `onTap` with the
 * embedded `data.id` and the chosen `actionIdentifier`. Lets the host
 * app route the tap to the appropriate consent screen — there's no
 * one-tap approve, since approving an OAuth/device request needs
 * scope selection that only the consent screen can collect.
 *
 * @remarks
 * `onTap` is captured in a ref so a host passing an inline arrow does
 * not tear down and re-add the expo-notifications listener on every
 * render.
 */
function useNotificationTapHandler(onTap: (tap: NotificationTap) => void): void {
  const onTapRef = useRef(onTap)
  useEffect(() => {
    onTapRef.current = onTap
  }, [onTap])

  useEffect(() => {
    const sub = addNotificationResponseReceivedListener((response) => {
      const decoded = decodeNotificationData(response.notification.request.content.data)
      if (Either.isLeft(decoded)) {
        // Loud-fail: a notification we received but can't route is a
        // delivery bug we want to see in logs/Sentry, not silently
        // swallowed. Effect's logger is wired through telemetry on
        // hosts that provide one.
        Effect.runFork(
          Effect.logError('gatekeeper-expo: notification tap missing valid data.id', {
            actionIdentifier: response.actionIdentifier,
            cause: decoded.left,
          })
        )
        return
      }
      onTapRef.current({ id: decoded.right.id, action: response.actionIdentifier })
    })
    return (): void => sub.remove()
  }, [])
}

export { useNotificationTapHandler }
export type { NotificationTap }
