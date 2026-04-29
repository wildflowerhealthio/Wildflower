import { useEffect, useRef, type JSX } from 'react'
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

function AnimatedHeaderBackground({
  cardColor,
  warningColor,
  borderColor,
  active,
}: AnimatedHeaderBackgroundProps): JSX.Element {
  const targetColor = active ? warningColor : cardColor
  const prevColor = useRef(targetColor)
  const progress = useSharedValue(1)

  useEffect(() => {
    progress.set(0)
    progress.value = withTiming(1, { duration: 400 })
    return (): void => {
      prevColor.current = targetColor
    }
  }, [targetColor, progress])

  const fromColor = prevColor.current
  const toColor = targetColor

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(progress.value, [0, 1], [fromColor, toColor])
    return { backgroundColor, shadowColor: backgroundColor }
  })

  return (
    <Animated.View
      style={[
        styles.headerBackground,
        animatedStyle,
        { borderBottomColor: active ? 'transparent' : borderColor },
        active && {
          shadowOpacity: 0.4,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  headerBackground: {
    flex: 1,
    borderBottomWidth: Borders.width,
  },
})

export { AnimatedHeaderBackground, type AnimatedHeaderBackgroundProps }
