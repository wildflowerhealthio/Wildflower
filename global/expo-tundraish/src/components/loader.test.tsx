import { render } from '@testing-library/react-native'
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native'

import { Colors } from '../theme.ts'
import { Loader } from './loader.tsx'

describe('Loader', () => {
  it('renders an ActivityIndicator', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy()
  })

  it.each([
    ['small', 'small'],
    [undefined, 'large'],
  ] as const)('renders ActivityIndicator at size %s', (input, expected) => {
    const { UNSAFE_getByType } = render(<Loader size={input} />)
    expect(UNSAFE_getByType(ActivityIndicator).props.size).toBe(expected)
  })

  // pointerEvents='none' rationale lives on Loader @remarks
  it('overlay does not intercept touches (pointerEvents="none")', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    const flat = StyleSheet.flatten<ViewStyle>(UNSAFE_getByType(View).props.style)
    expect(flat.pointerEvents).toBe('none')
  })

  it('overlay covers its parent (position: "absolute")', () => {
    const { UNSAFE_getByType } = render(<Loader />)
    const flat = StyleSheet.flatten<ViewStyle>(UNSAFE_getByType(View).props.style)
    expect(flat).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 })
  })

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
