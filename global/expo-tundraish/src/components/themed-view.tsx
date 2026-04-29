import { View, type ViewProps } from 'react-native'

import { type JSX } from 'react'
import { useThemeColors } from '../hooks/use-theme-colors.ts'

export type ThemedViewProps = ViewProps & {
  lightBackgroundColor?: string
  darkBackgroundColor?: string
}

export function ThemedView({
  style,
  lightBackgroundColor,
  darkBackgroundColor,
  ...otherProps
}: ThemedViewProps): JSX.Element {
  const { background: backgroundColor } = useThemeColors({
    background: { light: lightBackgroundColor, dark: darkBackgroundColor },
  })

  return <View style={[{ backgroundColor }, style]} {...otherProps} />
}
