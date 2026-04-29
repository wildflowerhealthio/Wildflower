import { pipe, Record as R } from 'effect'
import { Colors, type ColorToken } from '../theme.ts'
import { useColorScheme } from './use-color-scheme.ts'

type ThemeColorOverride = string | { light?: string; dark?: string; unspecified?: string }
type ThemeColorOverrides = Partial<Record<ColorToken, ThemeColorOverride>>

function useThemeColors(overrides: ThemeColorOverrides = {}): Record<ColorToken, string> {
  const theme = useColorScheme()
  let resolved: 'light' | 'dark' = 'light'
  if (theme === 'dark') {
    resolved = 'dark'
  }
  const palette: Record<ColorToken, string> = Colors[resolved]

  return pipe(
    palette,
    R.map((paletteValue, key) => {
      const override = overrides[key]
      if (typeof override === 'string') return override
      if (override) return override[resolved] ?? override[theme] ?? paletteValue
      return paletteValue
    })
  )
}

export { useThemeColors }
export type { ThemeColorOverride, ThemeColorOverrides }
