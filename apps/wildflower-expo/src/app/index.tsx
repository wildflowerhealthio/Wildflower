import { Effect } from 'effect'
import * as SplashScreen from 'expo-splash-screen'
import { Colors, Spacing, ThemedText, ThemedView, useThemeColors } from 'expo-tundraish'
import { ServerState } from 'local-http-server-core/livestore'
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AppShellWebView } from '../components/app-shell-webview.tsx'
import { useNavigationSender } from '../components/navigation-pipe.ts'
import { TABS, tabForPath, type TabKey } from '../components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'

// Splash is suppressed by `side-effect-imports/prevent-splash-hide.ts`
// (side-effect import in `index.ts`, before `expo-router/entry`).
// Here we only own the `hideAsync` reveal once the WebView is alive.

/** The persistent shell screen — mounts `<AppShellWebView>` and the native tab bar. */
export default function HomeScreen(): JSX.Element {
  const store = useWildflowerStore()
  const { running } = store.useQuery(ServerState.queries.current$)

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
    <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
      <ThemedView style={styles.fill}>
        <View style={styles.webViewWrap}>
          <AppShellWebView route={TABS[0].path} onRouteChanged={handleRouteChanged} />
        </View>
        <TabBar activeTab={activeTab} />
      </ThemedView>
    </SafeAreaView>
  )
}

/** Native tab bar — dispatches `HostRequestedWebNavigation` through the navigation pipe. */
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
              // Fire-and-forget: the only failure mode is the pipe's
              // own warn-and-drop (logged via `Effect.logWarning`) when
              // the transport hasn't built yet — not a swallowed
              // user-visible error.
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
