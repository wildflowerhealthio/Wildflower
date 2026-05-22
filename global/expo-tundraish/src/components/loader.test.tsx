import { render } from '@testing-library/react-native'
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native'

import { Colors } from '../theme.ts'
import { Loader } from './loader.tsx'

describe('Loader', () => {
  it('renders an ActivityIndicator', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy()
  })

  it('passes the size prop through to ActivityIndicator', () => {
    const { UNSAFE_getByType } = render(<Loader size="small" />)
    expect(UNSAFE_getByType(ActivityIndicator).props.size).toBe('small')
  })

  it('defaults to size="large"', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    expect(UNSAFE_getByType(ActivityIndicator).props.size).toBe('large')
  })

  // The overlay sits absolutely positioned over a relative parent
  // (e.g. the `loader` slot of `<WebView>`). `pointerEvents="none"`
  // is load-bearing: without it, touches that reach the loader while
  // it fades out would be swallowed instead of passing through to the
  // underlying view. The full-bleed `position: 'absolute'` is what
  // makes "sit on top of the parent" work at all.
  it('overlay does not intercept touches (pointerEvents="none")', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    expect(UNSAFE_getByType(View).props.pointerEvents).toBe('none')
  })

  it('overlay covers its parent (position: "absolute")', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    const flat = StyleSheet.flatten<ViewStyle>(UNSAFE_getByType(View).props.style)
    expect(flat).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 })
  })

  // Theme colours forward into both the backdrop and the spinner.
  // `useThemeColors` is not mocked: testing-library/react-native
  // resolves a real palette (defaults to `light`), so these assertions
  // catch a regression where either token was swapped, dropped, or
  // had its consumer rewired.
  it('forwards the palette icon colour to the ActivityIndicator', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    expect(UNSAFE_getByType(ActivityIndicator).props.color).toBe(Colors.light.icon)
  })

  it('paints the overlay with the palette background colour', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    const flat = StyleSheet.flatten<ViewStyle>(UNSAFE_getByType(View).props.style)
    expect(flat.backgroundColor).toBe(Colors.light.background)
  })
})
