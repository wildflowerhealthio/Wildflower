import { renderHook } from '@testing-library/react-native'
import type { ColorSchemeName } from 'react-native'

import { useColorScheme } from './use-color-scheme'

type MaybeScheme = ColorSchemeName | null | undefined

const mockUseRNColorScheme = jest.fn<MaybeScheme, []>()

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: (): MaybeScheme => mockUseRNColorScheme(),
}))

describe('useColorScheme', () => {
  beforeEach(() => {
    mockUseRNColorScheme.mockReset()
  })

  it("returns 'unspecified' when react-native returns null", () => {
    mockUseRNColorScheme.mockReturnValue(null)
    const { result } = renderHook(() => useColorScheme())
    expect(result.current).toBe('unspecified')
  })

  it("returns 'unspecified' when react-native returns undefined", () => {
    mockUseRNColorScheme.mockReturnValue(undefined)
    const { result } = renderHook(() => useColorScheme())
    expect(result.current).toBe('unspecified')
  })

  it("returns 'light' verbatim", () => {
    mockUseRNColorScheme.mockReturnValue('light')
    const { result } = renderHook(() => useColorScheme())
    expect(result.current).toBe('light')
  })

  it("returns 'dark' verbatim", () => {
    mockUseRNColorScheme.mockReturnValue('dark')
    const { result } = renderHook(() => useColorScheme())
    expect(result.current).toBe('dark')
  })
})
