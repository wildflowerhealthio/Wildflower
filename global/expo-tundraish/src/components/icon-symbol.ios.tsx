import { SymbolView, type SymbolWeight } from 'expo-symbols'
import { type JSX } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

import { type IconSymbolName } from './icon-symbol-mapping.ts'

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  weight = 'regular',
}: {
  name: IconSymbolName
  size?: number
  color: string
  style?: StyleProp<ViewStyle>
  weight?: SymbolWeight
}): JSX.Element {
  return (
    <SymbolView
      weight={weight}
      tintColor={color}
      resizeMode="scaleAspectFit"
      name={name}
      style={[
        {
          width: size,
          height: size,
        },
        style,
      ]}
    />
  )
}
