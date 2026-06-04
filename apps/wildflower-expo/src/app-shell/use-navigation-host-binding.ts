import { Effect } from 'effect'

import { type HostBindings, type BridgeTransport } from 'effect-messaging-core'
import { useColorScheme } from 'expo-tundraish'
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
  // Same ref-mirrored delivery for the OS colour scheme: WKWebView reports
  // `prefers-color-scheme: light` for `loadHTMLString` content regardless of
  // the device appearance, so the page can't read it on its own — the host
  // pushes it on every page `__Ready` and whenever it changes. `unspecified`
  // (the platform default before the OS reports either) collapses to
  // `'light'`, matching the bridge's `'light' | 'dark'` contract.
  const colorScheme: 'light' | 'dark' = useColorScheme() === 'dark' ? 'dark' : 'light'
  const colorSchemeRef = useRef(colorScheme)
  colorSchemeRef.current = colorScheme
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

  // Push the colour scheme when it changes mid-session (user toggles the
  // OS appearance). Mirrors the inset rotation effect above.
  useEffect(() => {
    if (!pageReadyRef.current) return
    Effect.runFork(
      navigationSenderRef.current({ _tag: 'HostColorSchemeChanged', scheme: colorScheme })
    )
  }, [colorScheme, navigationSenderRef])

  const navigationBindingArgs = useMemo(() => {
    return {
      onRouteChanged,
      onUiReady,
      // Fires on every page `__Ready` — first WebView mount and every
      // subsequent reload (Metro, blank-page workaround remount, …) —
      // so the ref-slot picks up the transport-stable sender each time,
      // and the page re-receives the current insets and colour scheme
      // after a relaunch (the rotation/scheme effects above only fire on
      // change, never on a fresh page load). The repeat write is benign
      // because `bindings.bridges` is pinned for the component's lifetime
      // — see the pinning rationale in `use-host-bindings.ts`. Reads insets
      // and scheme from refs so this callback (and the binding identity)
      // stays stable across their changes.
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
          yield* send({ _tag: 'HostColorSchemeChanged', scheme: colorSchemeRef.current })
        }),
      initialRoute: '/home',
    }
  }, [onRouteChanged, onUiReady, navigationSenderRef])

  const navigationBinding = NavigationBridgeExpo.useHostBinding(navigationBindingArgs)

  return navigationBinding
}
