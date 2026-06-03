import { Effect } from 'effect'

import { HostBindings, type Logging, type BridgeTransport } from 'effect-messaging-core'
import { useLogHostBinding } from 'effect-messaging-expo'

import { type AppsBridge } from 'apps-core/bridge'
import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { type CollectorBridge } from 'collector-fundamentals/bridge'
import { type GatekeeperBridge } from 'gatekeeper-core/bridge'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { type NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useEffect, useMemo, useRef } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useWildflowerStore } from '@/src/livestore/livestore-store.ts'
import { useNavigationSenderRef } from './navigation-pipe.tsx'

type NavigationSender = BridgeTransport.MessageSender<
  readonly [typeof NavigationBridge],
  'HostToWeb'
>

const useNavigationHostBinding = (
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

export const useHostBindings = ({
  onRouteChanged,
  onUiReady,
}: {
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Fires once the embedded SPA posts `UIReady` (auth gate passed +
   * startup prefetches settled). The shell hides the native splash /
   * reveals the WebView here.
   */
  onUiReady: () => void
}): HostBindings.HostBindings<
  readonly [
    typeof NavigationBridge,
    typeof GatekeeperBridge,
    typeof CollectorBridge,
    typeof AppsBridge,
    typeof Logging.LogBridge,
  ]
> => {
  const store = useWildflowerStore()
  // `localClientToken` is passed to gatekeeper's host binding so the
  // embedded SPA is authenticated on first load. `null` while bootstrap
  // is still in flight or the mint failed.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)
  const token = localClientToken ?? undefined

  const navigationBinding = useNavigationHostBinding(onRouteChanged, onUiReady)
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ store })
  const logBinding = useLogHostBinding()

  const combined = useMemo(
    () =>
      HostBindings.combine([
        navigationBinding,
        gatekeeperBinding,
        collectorBinding,
        appsBinding,
        logBinding,
      ] as const),
    [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding]
  )

  // Pin `bridges` to the first-render combined output. `HostBindings.combine`
  // allocates a fresh `bridges` array on every call, so any upstream
  // sub-binding identity flip (e.g. `useRouter()` returning a new
  // reference, or a slice handler closing over a per-render value) would
  // otherwise change `bindings.bridges` mid-life. `BridgedWebView`'s
  // build effect is keyed on `[bridges]`; a reference flip there tears
  // down the in-flight transport, builds a fresh one with a new
  // `peerReady` Deferred, and silently breaks the SPA: the page sends
  // `__Ready` exactly once per its own lifecycle, so the rebuilt
  // transport's gate never opens. Every HostToWeb push — including the
  // gatekeeper UI token — sits buffered in the closed outbox until the
  // next scope close logs
  // `[effect-messaging] outbound pump closed with N buffered message(s)
  // undelivered`. Pinning is correct because the bridge identities are
  // module-level constants (`NavigationBridge`, `GatekeeperBridge`, …)
  // — the tuple can't change at runtime. `handlers` deliberately stays
  // un-pinned so `BridgedWebView`'s registerHandlers path keeps slice
  // inbound logic up to date without disturbing the transport.
  const pinnedBridgesRef = useRef<typeof combined.bridges | null>(null)
  if (pinnedBridgesRef.current === null) pinnedBridgesRef.current = combined.bridges
  const pinnedBridges = pinnedBridgesRef.current

  return useMemo(
    () => ({
      bridges: pinnedBridges,
      handlers: combined.handlers,
      initialMessages: combined.initialMessages,
      onPageReady: combined.onPageReady,
    }),
    [combined, pinnedBridges]
  )
}
