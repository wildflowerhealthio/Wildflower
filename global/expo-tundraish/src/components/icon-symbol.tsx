// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { SymbolWeight } from 'expo-symbols'
import { type JSX } from 'react'
import type { OpaqueColorValue, StyleProp, TextStyle } from 'react-native'

import { MAPPING, type IconSymbolName } from './icon-symbol-mapping.ts'

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName
  size?: number
  color: string | OpaqueColorValue
  style?: StyleProp<TextStyle>
  weight?: SymbolWeight
}): JSX.Element {
  return <MaterialIcons color={color} size={size} name={MAPPING[name]} style={style} />
}
