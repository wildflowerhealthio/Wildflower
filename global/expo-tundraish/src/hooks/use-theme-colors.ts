import { pipe, Record as R } from 'effect'
import { Colors, type ColorToken } from '../theme.ts'
import { useColorScheme } from './use-color-scheme.ts'

type ThemeColorOverride = string | { light?: string; dark?: string; unspecified?: string }
type ThemeColorOverrides = Partial<Record<ColorToken, ThemeColorOverride>>

/**
 * Resolves a palette token through optional per-call overrides.
 *
 * Override precedence:
 * - Active scheme is `'light'` or `'dark'`: only `override[scheme]` is consulted; `override.unspecified` is ignored so it cannot leak into themed contexts.
 * - Active scheme is `'unspecified'`: `override.unspecified` wins, falling back to `override.light` (the resolved palette in the unspecified case), then the palette default.
 * - A bare string override applies in every scheme.
 */
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
      if (!override) return paletteValue
      if (theme === 'unspecified') {
        return override.unspecified ?? override[resolved] ?? paletteValue
      }
      return override[theme] ?? paletteValue
    })
  )
}

export { useThemeColors }
export type { ThemeColorOverride, ThemeColorOverrides }
