import { NavigationBridge } from 'contracts-core'
import { Effect, Exit, Scope } from 'effect'
import {
  EffectMessagingWebView,
  type EffectMessagingWebViewHandle,
  type ExpoTransport,
  makeExpoTransport,
  type SetHeaderLeft,
} from 'effect-messaging-expo'
import { useNavigation } from 'expo-router'
import { Colors, useColorScheme } from 'expo-tundraish'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { html } from 'wildflower-react/embeddable-html'

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly token?: string
}

type Bridges = readonly [NavigationBridge, typeof GatekeeperBridge]

/**
 * Embedded gatekeeper SPA wrapped for the Expo host. Composes
 * {@link NavigationBridge} (initial route, host-driven nav, route
 * tracking, host-side back) with {@link GatekeeperBridge} (bearer token
 * delivery) and threads them through {@link makeExpoTransport}.
 *
 * @remarks
 * The transport is constructed inside `useEffect` rather than at module
 * load: it owns a `Scope` whose finalizers (dispatch fiber interrupt,
 * queue shutdown) must run on unmount. The ref forwarding the
 * `EffectMessagingWebView` exposes is created here and passed down to
 * the transport — the generic transport package no longer owns
 * navigator chrome.
 *
 * The back-chevron is rendered into the navigator's header here:
 * `useNavigation()` from expo-router gives the slice access to the
 * screen's `headerLeft`, and the bridge's `RouteChanged` payload's
 * `canGoBack` flag drives whether the chevron renders.
 */
function GatekeeperWebView({ baseUrl, route, token }: GatekeeperWebViewProps): JSX.Element {
  const [transport, setTransport] = useState<ExpoTransport<Bridges> | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const colorScheme = useColorScheme()
  const palette = colorScheme === 'dark' ? Colors.dark : Colors.light

  // The consumer owns the WebView ref so the transport package stays
  // navigator-agnostic. `EffectMessagingWebViewHandle` is structurally
  // identical to the transport's `WebViewHandle` (both
  // `{ postMessage(s: string): void }`), so one cell drives both.
  const webviewHandleRef = useRef<EffectMessagingWebViewHandle | null>(null)

  useEffect(() => {
    const initialMessages = [
      { _tag: 'HostRequestedWebNavigation' as const, path: route },
      ...(token === undefined ? [] : [{ _tag: 'AuthTokenIssued' as const, token }]),
    ]
    const navigationLayer = NavigationBridge.Host.ReceiverLayer({
      RouteChanged: ({ canGoBack: cgb }) => Effect.sync(() => setCanGoBack(cgb)),
    })
    const gatekeeperLayer = GatekeeperBridge.Host.ReceiverLayer({})

    const scope = Effect.runSync(Scope.make())
    const program = makeExpoTransport({
      bridges: [NavigationBridge, GatekeeperBridge] as const,
      layers: [navigationLayer, gatekeeperLayer] as const,
      initialMessages,
      webviewHandleRef,
    })
    const built = Effect.runSync(Scope.extend(program, scope))
    setTransport(built)
    return (): void => {
      Effect.runSync(Scope.close(scope, Exit.void))
      setTransport(null)
    }
  }, [route, token])

  const onBackPress = useCallback((): void => {
    if (transport === null) return
    Effect.runSync(transport.sendMessage({ _tag: 'HostBackRequested' }))
  }, [transport])

  // Bridge the navigator-agnostic `setHeaderLeft` prop to expo-router's
  // `useNavigation().setOptions({ headerLeft })`. The chevron only
  // renders when `canGoBack` is true; otherwise we send `undefined` so
  // the navigator falls back to its default header.
  const navigation = useNavigation()
  const setHeaderLeft: SetHeaderLeft = useCallback(
    (renderer) => {
      navigation.setOptions({ headerLeft: renderer })
    },
    [navigation]
  )
  const headerLeft = useMemo(() => {
    if (!canGoBack) return undefined
    return ({ tintColor }: { tintColor?: string }): JSX.Element => (
      <Pressable
        onPress={onBackPress}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={12}
      >
        <Text style={[styles.backLabel, tintColor ? { color: tintColor } : null]}>‹ Back</Text>
      </Pressable>
    )
  }, [canGoBack, onBackPress])

  if (transport === null) return <></>

  const loader = (
    <View
      style={[styles.loaderOverlay, { backgroundColor: palette.background }]}
      pointerEvents="none"
    >
      <ActivityIndicator size="large" color={palette.icon} />
    </View>
  )

  return (
    <EffectMessagingWebView
      ref={webviewHandleRef}
      source={{ html, baseUrl }}
      injectedScript={transport.injectedScript}
      onMessage={transport.onMessage}
      loader={loader}
      setHeaderLeft={setHeaderLeft}
      headerLeft={headerLeft}
    />
  )
}

const styles = StyleSheet.create({
  loaderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backLabel: { fontSize: 17 },
})

export { GatekeeperWebView }
export type { GatekeeperWebViewProps }
