import { type JSX } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useThemeColors } from '../hooks/use-theme-colors.ts'

type LoaderProps = {
  /** Spinner size; mirrors `ActivityIndicator`'s `size` prop. */
  readonly size?: 'small' | 'large' | number
}

/**
 * Full-bleed loader overlay: an `ActivityIndicator` centered over a
 * palette-coloured backdrop, sized to fill its parent until the
 * underlying view is ready to take over.
 *
 * @remarks
 * The overlay is absolutely positioned to fill its relative parent.
 * `pointerEvents: 'none'` lets touches pass through during fade-out,
 * so screen readers and gesture handlers behind the loader still work
 * as the underlying view takes over.
 */
function Loader({ size = 'large' }: LoaderProps = {}): JSX.Element {
  const { background, icon } = useThemeColors()
  return (
    <View
      style={[styles.overlay, { backgroundColor: background }, { pointerEvents: 'none' }]}
      accessibilityLabel="Loading"
    >
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
