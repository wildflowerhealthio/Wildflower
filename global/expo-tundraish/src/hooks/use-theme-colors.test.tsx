import { renderHook } from '@testing-library/react-native'
import type { ColorSchemeName } from 'react-native'

import { Colors } from '../theme'
import { useThemeColors } from './use-theme-colors'

type MaybeScheme = ColorSchemeName | null | undefined

const mockUseRNColorScheme = jest.fn<MaybeScheme, []>()

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: (): MaybeScheme => mockUseRNColorScheme(),
}))

const setScheme = (s: MaybeScheme): void => {
  mockUseRNColorScheme.mockReturnValue(s)
}

describe('useThemeColors', () => {
  beforeEach(() => {
    mockUseRNColorScheme.mockReset()
  })

  it('returns the palette for the active scheme when no overrides are passed', () => {
    setScheme('light')
    const { result: light } = renderHook(() => useThemeColors())
    expect(light.current.background).toBe(Colors.light.background)
    expect(light.current.accent).toBe(Colors.light.accent)

    setScheme('dark')
    const { result: dark } = renderHook(() => useThemeColors())
    expect(dark.current.background).toBe(Colors.dark.background)
    expect(dark.current.accent).toBe(Colors.dark.accent)
  })

  it('treats null scheme as unspecified, resolving via the light palette', () => {
    setScheme(null)
    const { result } = renderHook(() => useThemeColors())
    expect(result.current.background).toBe(Colors.light.background)
  })

  describe('override precedence', () => {
    it('applies a string override regardless of scheme', () => {
      setScheme('light')
      const { result: l } = renderHook(() => useThemeColors({ accent: '#abcdef' }))
      expect(l.current.accent).toBe('#abcdef')

      setScheme('dark')
      const { result: d } = renderHook(() => useThemeColors({ accent: '#abcdef' }))
      expect(d.current.accent).toBe('#abcdef')
    })

    it('uses override.light only when scheme is light', () => {
      setScheme('light')
      const { result: l } = renderHook(() =>
        useThemeColors({ accent: { light: '#aaa', dark: '#bbb' } })
      )
      expect(l.current.accent).toBe('#aaa')
    })

    it('uses override.dark only when scheme is dark', () => {
      setScheme('dark')
      const { result: d } = renderHook(() =>
        useThemeColors({ accent: { light: '#aaa', dark: '#bbb' } })
      )
      expect(d.current.accent).toBe('#bbb')
    })

    it('ignores override.unspecified when scheme is light or dark', () => {
      setScheme('light')
      const { result: l } = renderHook(() => useThemeColors({ accent: { unspecified: '#bbb' } }))
      expect(l.current.accent).toBe(Colors.light.accent)

      setScheme('dark')
      const { result: d } = renderHook(() => useThemeColors({ accent: { unspecified: '#bbb' } }))
      expect(d.current.accent).toBe(Colors.dark.accent)
    })

    it('prefers override.unspecified over override.light when scheme is unspecified', () => {
      // Regression for the precedence flip: the previous implementation
      // returned override.light here.
      setScheme(null)
      const { result } = renderHook(() =>
        useThemeColors({ accent: { light: '#aaa', unspecified: '#bbb' } })
      )
      expect(result.current.accent).toBe('#bbb')
    })

    it('falls back to override.light when scheme is unspecified and no unspecified key', () => {
      setScheme(null)
      const { result } = renderHook(() => useThemeColors({ accent: { light: '#aaa' } }))
      expect(result.current.accent).toBe('#aaa')
    })

    it('falls back to the palette when no relevant override key matches', () => {
      setScheme('light')
      const { result } = renderHook(() => useThemeColors({ accent: { dark: '#bbb' } }))
      expect(result.current.accent).toBe(Colors.light.accent)
    })
  })
})
