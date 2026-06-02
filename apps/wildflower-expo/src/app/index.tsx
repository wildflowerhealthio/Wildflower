import { Effect } from 'effect'
import { Colors, Spacing, ThemedText, ThemedView, useThemeColors } from 'expo-tundraish'
import { useCallback, useState, type JSX } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppShellWebView } from '../app-shell/app-shell-webview.tsx'
import { useNavigationSender } from '../app-shell/navigation-pipe.tsx'
import { TABS, tabForPath, type TabKey } from '../components/tab-mapping.ts'

// Splash is suppressed by `side-effect-imports/prevent-splash-hide.ts`
// (side-effect import in `index.ts`, before `expo-router/entry`).
// Here we only own the `hideAsync` reveal once the WebView is alive.

/** The persistent shell screen — mounts `<AppShellWebView>` and the native tab bar. */
export default function HomeScreen(): JSX.Element {
  const palette = useThemeColors()
  const sendNavigation = useNavigationSender()
  const insets = useSafeAreaInsets()

  const [activeTab, setActiveTab] = useState<TabKey | null>('apps')

  const handleRouteChanged = useCallback(
    ({ pathname }: { pathname: string; canGoBack: boolean }): void => {
      setActiveTab(tabForPath(pathname))
    },
    []
  )

  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <ThemedView style={styles.fill}>
        <View style={styles.webViewWrap}>
          <AppShellWebView onRouteChanged={handleRouteChanged} />
        </View>
        <View
          style={[
            styles.tabBar,
            {
              borderTopColor: palette.icon,
              backgroundColor: palette.background,
            },
          ]}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <Pressable
                key={tab.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                onPress={() => {
                  console.debug('Tab press:', tab.label)
                  Effect.runFork(
                    sendNavigation({ _tag: 'HostRequestedWebNavigation', path: tab.path })
                  )
                }}
                style={{
                  ...styles.tabButton,
                  paddingBottom: Math.max(Spacing.s2, insets.bottom - 12),
                }}
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
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webViewWrap: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.s3,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.s2,
  },
})
