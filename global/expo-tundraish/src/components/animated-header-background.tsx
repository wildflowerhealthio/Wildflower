import { useEffect, type JSX } from 'react'
import { StyleSheet } from 'react-native'
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import { Borders } from '../theme.ts'

type AnimatedHeaderBackgroundProps = {
  cardColor: string
  warningColor: string
  borderColor: string
  active: boolean
}

const ANIMATION_DURATION_MS = 400
const ACTIVE_SHADOW_OPACITY = 0.4
const ACTIVE_SHADOW_RADIUS = 8
const ACTIVE_SHADOW_OFFSET_Y = 2
const ACTIVE_ELEVATION = 4

function AnimatedHeaderBackground({
  cardColor,
  warningColor,
  borderColor,
  active,
}: AnimatedHeaderBackgroundProps): JSX.Element {
  const progress = useSharedValue(active ? 1 : 0)

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, { duration: ANIMATION_DURATION_MS })
  }, [active, progress])

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(progress.value, [0, 1], [cardColor, warningColor])
    return {
      backgroundColor,
      shadowColor: backgroundColor,
      shadowOpacity: progress.value * ACTIVE_SHADOW_OPACITY,
      shadowRadius: progress.value * ACTIVE_SHADOW_RADIUS,
      shadowOffset: { width: 0, height: progress.value * ACTIVE_SHADOW_OFFSET_Y },
      elevation: progress.value * ACTIVE_ELEVATION,
      borderBottomColor: interpolateColor(progress.value, [0, 1], [borderColor, 'transparent']),
    }
  })

  return <Animated.View style={[styles.headerBackground, animatedStyle]} />
}

const styles = StyleSheet.create({
  headerBackground: {
    flex: 1,
    borderBottomWidth: Borders.width,
  },
})

export { AnimatedHeaderBackground, type AnimatedHeaderBackgroundProps }
