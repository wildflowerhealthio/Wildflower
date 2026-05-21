import { Effect } from 'effect'
import { useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { Colors, Spacing, ThemedText, ThemedView, useThemeColors } from 'expo-tundraish'
import { useCallback, useContext, useEffect, useState, type JSX } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { AppShellContext } from '../components/app-shell-context.ts'
import { AppShellWebView } from '../components/app-shell-webview.tsx'
import { TABS, tabForPath, type TabKey } from '../components/tab-mapping.ts'
import { useShellOrigins } from '../livestore/use-shell-origins.ts'

// Splash is suppressed by `splash-init.ts` (side-effect import in
// `index.ts`, before `expo-router/entry`). Here we only own the
// `hideAsync` reveal once the WebView is alive.

/**
 * The persistent shell screen. Boots the on-device server, then
 * mounts `<AppShellWebView>` once everything is ready and reveals
 * the splash. The native tab bar below the WebView sends
 * `HostRequestedWebNavigation` over the bridge — the WebView never
 * unmounts on tab switch.
 */
export default function HomeScreen(): JSX.Element {
  const ctx = useContext(AppShellContext)
  if (ctx === null) throw new Error('AppShellContext missing — render under <RootLayout>')
  const { shellRef, setPendingSource } = ctx

  const { running, localOrigin, publicOrigin } = useShellOrigins()

  const router = useRouter()
  const palette = useThemeColors()
  const [activeTab, setActiveTab] = useState<TabKey>('apps')
  const [shellLive, setShellLive] = useState(false)

  // Hide the splash only after both the server is up AND the SPA has
  // reported a first `RouteChanged` (which means the embedded
  // wildflower-react has mounted + the transport has flushed).
  useEffect(() => {
    if (running) void SplashScreen.hideAsync()
  }, [running, shellLive])

  const handleRouteChanged = useCallback(
    ({ pathname }: { pathname: string; canGoBack: boolean }): void => {
      setActiveTab(tabForPath(pathname))
      setShellLive(true)
    },
    []
  )

  const navigateWebView = useCallback(
    (path: string): void => {
      const handle = shellRef.current
      if (handle === null) {
        // Pressed before the WebView mounted — only happens if the tab
        // bar somehow rendered before the shell, which the `!running`
        // guard above should prevent. Log so we notice if it ever does.
        console.warn('navigateWebView: shellRef is null, dropping navigation', { path })
        return
      }
      Effect.runFork(handle.sendMessage({ _tag: 'HostRequestedWebNavigation', path }))
    },
    [shellRef]
  )

  const handleRequestSniffableWebView = useCallback(
    (
      source: Parameters<
        NonNullable<React.ComponentProps<typeof AppShellWebView>['onRequestSniffableWebView']>
      >[0]
    ): void => {
      setPendingSource(source)
      router.push('/run-sync-modal')
    },
    [router, setPendingSource]
  )

  if (!running) {
    // Splash is still up; return an empty placeholder so the tree mounts.
    return <ThemedView style={styles.fill} />
  }

  return (
    <ThemedView style={styles.fill}>
      <View style={styles.webViewWrap}>
        <AppShellWebView
          ref={shellRef}
          baseUrl={publicOrigin ?? localOrigin}
          route={TABS[0].path}
          onRouteChanged={handleRouteChanged}
          onRequestSniffableWebView={handleRequestSniffableWebView}
        />
      </View>
      <View
        style={[
          styles.tabBar,
          { borderTopColor: palette.icon, backgroundColor: palette.background },
        ]}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              onPress={() => navigateWebView(tab.path)}
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
    </ThemedView>
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
