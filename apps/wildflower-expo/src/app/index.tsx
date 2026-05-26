import { Effect } from 'effect'
import * as SplashScreen from 'expo-splash-screen'
import { Colors, Spacing, ThemedText, ThemedView, useThemeColors } from 'expo-tundraish'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { localOrigin$, ServerState } from 'local-http-server-core/livestore'
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { AppShellWebView } from '../components/app-shell-webview.tsx'
import { useNavigationSender } from '../components/navigation-pipe.ts'
import { TABS, tabForPath, type TabKey } from '../components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'

// Splash is suppressed by `side-effect-imports/prevent-splash-hide.ts`
// (side-effect import in `index.ts`, before `expo-router/entry`).
// Here we only own the `hideAsync` reveal once the WebView is alive.

/**
 * The persistent shell screen. Boots the on-device server, then
 * mounts `<AppShellWebView>` once everything is ready and reveals
 * the splash. The native tab bar is rendered as a sibling of the
 * shell WebView — both live under `<NavigationPipeProvider>` (in
 * `_layout.tsx`), so the tab bar's press handlers dispatch typed
 * navigation messages through the same transport `AppShellWebView`
 * built.
 */
export default function HomeScreen(): JSX.Element {
  const store = useWildflowerStore()
  const { running } = store.useQuery(ServerState.queries.current$)
  // The embedded SPA always loads against the loopback origin so its
  // API calls hit `127.0.0.1` directly — never the public tunnel
  // relay (whose captive-portal interstitial returns 511 to
  // non-browser requests). Tunneled-app launches use the tunnel
  // origin separately, wired inside `apps-react`'s launch flow.
  const baseUrl = store.useQuery(localOrigin$)
  // `LocalClientToken` is minted by `HttpServerDaemonLive`'s
  // bootstrap step and committed into the gatekeeper slice store;
  // we pass it to `<AppShellWebView>` so the embedded SPA is
  // authenticated on first load without going through the
  // device-code flow. `null` while bootstrap is still in flight or
  // the mint failed; coerced to `undefined` so
  // `useGatekeeperHostBinding`'s `token === undefined` guard matches
  // the never-issued case (omits the `onTransportReady` issuance).
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)

  const [activeTab, setActiveTab] = useState<TabKey>('apps')
  const [shellLive, setShellLive] = useState(false)

  // Hide the splash only after both the server is up AND the SPA has
  // reported a first `RouteChanged` (which means the embedded
  // wildflower-react has mounted + the transport has flushed).
  useEffect(() => {
    if (running && shellLive) void SplashScreen.hideAsync()
  }, [running, shellLive])

  const handleRouteChanged = useCallback(
    ({ pathname }: { pathname: string; canGoBack: boolean }): void => {
      setActiveTab(tabForPath(pathname))
      setShellLive(true)
    },
    []
  )

  return (
    <ThemedView style={styles.fill}>
      <View style={styles.webViewWrap}>
        <AppShellWebView
          baseUrl={baseUrl}
          route={TABS[0].path}
          token={localClientToken ?? undefined}
          onRouteChanged={handleRouteChanged}
        />
      </View>
      <TabBar activeTab={activeTab} />
    </ThemedView>
  )
}

/**
 * Native tab bar. Lives under `<NavigationPipeProvider>` (mounted in
 * `_layout.tsx`) so `useNavigationSender()` resolves to the sender
 * `<AppShellWebView>` registered via `useAsNavigationSource` once
 * its `<BridgedWebView>` transport finished building. Pre-transport
 * presses route through the pipe's warn-and-drop default and surface
 * in logs (see `navigation-pipe.ts`).
 */
const TabBar = ({ activeTab }: { activeTab: TabKey }): JSX.Element => {
  const palette = useThemeColors()
  const sendNavigation = useNavigationSender()
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
            onPress={() => {
              Effect.runFork(sendNavigation({ _tag: 'HostRequestedWebNavigation', path: tab.path }))
            }}
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
