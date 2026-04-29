import { render, fireEvent } from '@testing-library/react-native'

import { ThemedButton } from './themed-button'

describe('ThemedButton', () => {
  it('should render with the given title', () => {
    const { getByText } = render(<ThemedButton title="Press me" onPress={jest.fn()} />)
    expect(getByText('Press me')).toBeTruthy()
  })

  it('should fire onPress when pressed', () => {
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Click" onPress={onPress} />)
    fireEvent.press(getByText('Click'))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('should render with variant="filled" (default)', () => {
    const { getByText } = render(<ThemedButton title="Filled" onPress={jest.fn()} />)
    expect(getByText('Filled')).toBeTruthy()
  })

  it('should render with variant="outline"', () => {
    const { getByText } = render(
      <ThemedButton title="Outline" variant="outline" onPress={jest.fn()} />
    )
    expect(getByText('Outline')).toBeTruthy()
  })

  it('should render with variant="ghost"', () => {
    const { getByText } = render(<ThemedButton title="Ghost" variant="ghost" onPress={jest.fn()} />)
    expect(getByText('Ghost')).toBeTruthy()
  })

  it('should not fire onPress when disabled', () => {
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Disabled" onPress={onPress} disabled />)
    fireEvent.press(getByText('Disabled'))
    expect(onPress).not.toHaveBeenCalled()
  })
})
