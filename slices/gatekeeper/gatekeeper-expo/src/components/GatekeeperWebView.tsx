import { Effect } from 'effect'
import {
  EffectMessagingWebView,
  useTransport,
  type EffectMessagingWebViewHandle,
  type ExpoTransport,
} from 'effect-messaging-expo'
import { useNavigation } from 'expo-router'
import { Colors, useColorScheme } from 'expo-tundraish'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'
import { useCallback, useMemo, useRef, type JSX } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View, Text } from 'react-native'
import { html } from 'wildflower-react/embeddable-html'

type Bridges = readonly [NavigationBridge, typeof GatekeeperBridge]

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly token?: string
}

/**
 * Embedded gatekeeper SPA wrapped for the Expo host. Owns the
 * {@link ExpoTransport} lifecycle (bridges, layers, initial messages,
 * scope) and the navigator chrome (`headerLeft` for the
 * `RouteChanged` back affordance), and renders an
 * {@link EffectMessagingWebView} with a loader overlay tinted for the
 * active color scheme.
 */
const GatekeeperWebView = ({ baseUrl, route, token }: GatekeeperWebViewProps): JSX.Element => {
  const navigation = useNavigation()
  const webviewHandleRef = useRef<EffectMessagingWebViewHandle>(null)

  const setHeaderLeft = useCallback(
    (renderer: undefined | ((props: { tintColor: string }) => JSX.Element)) => {
      navigation.setOptions({ headerLeft: renderer })
    },
    [navigation]
  )

  const initialMessages = [
    { _tag: 'HostRequestedWebNavigation' as const, path: route },
    ...(token === undefined ? [] : [{ _tag: 'AuthTokenIssued' as const, token }]),
  ]

  const transport: ExpoTransport<Bridges> = useTransport({
    initialMessages,
    bridges: [NavigationBridge, GatekeeperBridge] as const,
    layers: [
      NavigationBridge.Host.ReceiverLayer({
        RouteChanged: ({ canGoBack: cgb }) =>
          Effect.sync(() => {
            if (cgb) {
              setHeaderLeft(backButton)
            } else {
              setHeaderLeft(undefined)
            }
          }),
      }),
      GatekeeperBridge.Host.ReceiverLayer({}),
    ] as const,
    webviewHandleRef,
  })

  const onBackPress = useCallback((): void => {
    Effect.runSync(transport.sendMessage({ _tag: 'HostBackRequested' }))
  }, [transport])

  const backButton = useMemo(
    () =>
      ({ tintColor }: { tintColor?: string }): JSX.Element => (
        <Pressable
          onPress={onBackPress}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text style={[styles.backLabel, tintColor ? { color: tintColor } : null]}>‹ Back</Text>
        </Pressable>
      ),
    [onBackPress]
  )

  return (
    <EffectMessagingWebView
      ref={webviewHandleRef}
      source={{ html, baseUrl }}
      injectedScript={transport.injectedScript}
      onMessage={transport.onMessage}
      loader={<Loader />}
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

const Loader = (): JSX.Element => {
  const colorScheme = useColorScheme()
  const palette = colorScheme === 'dark' ? Colors.dark : Colors.light
  return (
    <View
      style={[styles.loaderOverlay, { backgroundColor: palette.background }]}
      pointerEvents="none"
    >
      <ActivityIndicator size="large" color={palette.icon} />
    </View>
  )
}

export { GatekeeperWebView }
export type { Bridges, GatekeeperWebViewProps }
