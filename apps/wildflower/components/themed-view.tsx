import { View, type ViewProps } from 'react-native'

import { type JSX } from 'react'
import { useThemeColor } from '../hooks/use-theme-color'

export type ThemedViewProps = ViewProps & {
  lightColor?: string
  darkColor?: string
}

export function ThemedView({
  style,
  lightColor,
  darkColor,
  ...otherProps
}: ThemedViewProps): JSX.Element {
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background')

  return <View style={[{ backgroundColor }, style]} {...otherProps} />
}
