import { Effect } from 'effect'

import { type HostBindings, type BridgeTransport } from 'effect-messaging-core'
import { type NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useEffect, useMemo, useRef } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigationSenderRef } from './navigation-pipe.tsx'

type NavigationSender = BridgeTransport.MessageSender<
  readonly [typeof NavigationBridge],
  'HostToWeb'
>

export const useNavigationHostBinding = (
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void,
  onUiReady: () => void
): HostBindings.HostBindings<readonly [typeof NavigationBridge]> => {
  const navigationSenderRef = useNavigationSenderRef()

  // Mirror gatekeeper's token delivery for the safe-area insets: read the
  // current values from a ref so the transport-stable `onPageReady` can
  // re-push them on every reload, while the rotation effect below covers
  // mid-session changes. `bottom` is forced to `0` — the native tab bar
  // sits below the WebView and already owns the bottom inset.
  const insets = useSafeAreaInsets()
  const insetsRef = useRef(insets)
  insetsRef.current = insets
  // Gates the rotation effect until `onPageReady` has installed the real
  // transport sender; before that `navigationSenderRef` holds the pipe's
  // warn-and-drop default, and the next `onPageReady` re-pushes via
  // `insetsRef` anyway.
  const pageReadyRef = useRef(false)

  // Push insets when they change mid-session (rotation, keyboard,
  // multitasking resize). Keyed on the three values we actually send.
  useEffect(() => {
    if (!pageReadyRef.current) return
    Effect.runFork(
      navigationSenderRef.current({
        _tag: 'SafeAreaInsetsChanged',
        top: insets.top,
        bottom: 0,
        left: insets.left,
        right: insets.right,
      })
    )
  }, [insets.top, insets.left, insets.right, navigationSenderRef])

  const navigationBindingArgs = useMemo(() => {
    return {
      onRouteChanged,
      onUiReady,
      // Fires on every page `__Ready` — first WebView mount and every
      // subsequent reload (Metro, blank-page workaround remount, …) —
      // so the ref-slot picks up the same transport-stable sender
      // each time, and the page re-receives the current insets after a
      // relaunch (the rotation effect above only fires on change, never
      // on a fresh page load). The repeat write is benign: `sendMessage`
      // identity is fixed for the surrounding transport's lifetime, and
      // the shell's `useHostBindings` pins `bindings.bridges` so that
      // lifetime spans the whole component mount. Reads insets from a
      // ref so this callback (and thus the binding identity) stays
      // stable across inset changes.
      onPageReady: (send: NavigationSender) =>
        Effect.gen(function* () {
          navigationSenderRef.current = send
          pageReadyRef.current = true
          const current = insetsRef.current
          yield* send({
            _tag: 'SafeAreaInsetsChanged',
            top: current.top,
            bottom: 0,
            left: current.left,
            right: current.right,
          })
        }),
      initialRoute: '/home',
    }
  }, [onRouteChanged, onUiReady, navigationSenderRef])

  const navigationBinding = NavigationBridgeExpo.useHostBinding(navigationBindingArgs)

  return navigationBinding
}
