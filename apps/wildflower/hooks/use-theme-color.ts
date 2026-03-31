/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '../constants/theme'
import { useColorScheme } from './use-color-scheme'

export function useThemeColor(
  props: { light?: string; dark?: string; unspecified?: string },
  // oxlint-disable-next-line typescript/no-duplicate-type-constituents
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
): string {
  const theme = useColorScheme() ?? 'light'
  const colorFromProps = props[theme]

  if (colorFromProps) {
    return colorFromProps
  } else {
    return Colors[theme][colorName]
  }
}
