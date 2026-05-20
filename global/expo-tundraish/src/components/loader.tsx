import { type JSX } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useThemeColors } from '../hooks/use-theme-colors.ts'

type LoaderProps = {
  /** Spinner size; mirrors `ActivityIndicator`'s `size` prop. */
  readonly size?: 'small' | 'large' | number
}

/**
 * Full-bleed loader overlay: an `ActivityIndicator` centered over a
 * palette-coloured backdrop. Designed to sit absolutely positioned
 * inside a relative parent (e.g. the `loader` slot of
 * `react-native-webview`'s `<WebView>`), filling that parent until
 * the underlying view is ready to take over.
 */
function Loader({ size = 'large' }: LoaderProps = {}): JSX.Element {
  const { background, icon } = useThemeColors()
  return (
    <View style={[styles.overlay, { backgroundColor: background }]} pointerEvents="none">
      <ActivityIndicator size={size} color={icon} />
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

export { Loader }
export type { LoaderProps }
