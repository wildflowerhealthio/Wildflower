import * as SplashScreen from 'expo-splash-screen'
import { Colors, Spacing, ThemedText, ThemedView, useThemeColors } from 'expo-tundraish'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { ServerState } from 'local-http-server-core/livestore'
import { useNavigationHostMessaging } from 'navigation-react'
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { servedOrigin$ } from 'tunnel-core/livestore'

import { AppShellWebView } from '../components/app-shell-webview.tsx'
import { TABS, tabForPath, type TabKey } from '../components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'

// Splash is suppressed by `splash-init.ts` (side-effect import in
// `index.ts`, before `expo-router/entry`). Here we only own the
// `hideAsync` reveal once the WebView is alive.

/**
 * The persistent shell screen. Boots the on-device server, then
 * mounts `<AppShellWebView>` once everything is ready and reveals
 * the splash. The native tab bar is passed as `children` of
 * `<AppShellWebView>` so it lives inside the host-messaging
 * provider — its press handlers dispatch typed
 * `HostRequestedWebNavigation` messages via `useNavigationHostMessaging`.
 * The WebView never unmounts on tab switch.
 */
export default function HomeScreen(): JSX.Element {
  const store = useWildflowerStore()
  const { running } = store.useQuery(ServerState.queries.current$)
  const servedOrigin = store.useQuery(servedOrigin$)
  // `LocalClientToken` is minted by `HttpServerDaemonLive`'s
  // bootstrap step and committed into the gatekeeper slice store; we
  // pass it to `<AppShellWebView>` so the embedded SPA is authenticated
  // on first load without going through the device-code flow. `null`
  // while bootstrap is still in flight or the mint failed; converted
  // to `undefined` so the optional prop's `token === undefined` guard
  // inside the inner shell matches the never-issued case.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)

  const [activeTab, setActiveTab] = useState<TabKey>('apps')
  const [shellLive, setShellLive] = useState(false)

  // Hide the splash only after both the server is up AND the SPA has
  // reported a first `RouteChanged` (which means the embedded
  // wildflower-react has mounted + the transport has flushed).
  useEffect(() => {
    if (running) void SplashScreen.hideAsync()
  }, [running])

  const handleRouteChanged = useCallback(
    ({ pathname }: { pathname: string; canGoBack: boolean }): void => {
      setActiveTab(tabForPath(pathname))
      setShellLive(true)
    },
    []
  )

  return (
    <ThemedView style={styles.fill}>
      <AppShellWebView
        baseUrl={servedOrigin}
        route={TABS[0].path}
        token={localClientToken ?? undefined}
        onRouteChanged={handleRouteChanged}
        belowWebView={<TabBar activeTab={activeTab} />}
      />
    </ThemedView>
  )
}

/**
 * Native tab bar. Lives inside `<AppShellWebView>`'s host-messaging
 * provider so it can dispatch typed navigation messages via
 * `useNavigationHostMessaging`. The transport buffers the message
 * until the SPA is ready.
 */
const TabBar = ({ activeTab }: { activeTab: TabKey }): JSX.Element => {
  const palette = useThemeColors()
  const { send: sendNavigation } = useNavigationHostMessaging()
  return (
    <View
      style={[styles.tabBar, { borderTopColor: palette.icon, backgroundColor: palette.background }]}
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            onPress={() => sendNavigation({ _tag: 'HostRequestedWebNavigation', path: tab.path })}
            style={styles.tabButton}
          >
            <ThemedText
              type={isActive ? 'bodySemiBold' : 'body'}
              lightTextColor={isActive ? Colors.light.accent : Colors.light.icon}
              darkTextColor={isActive ? Colors.dark.accent : Colors.dark.icon}
            >
              {tab.label}
            </ThemedText>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webViewWrap: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.s3,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.s2,
  },
})
