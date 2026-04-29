import { fireEvent, render } from '@testing-library/react-native'

import { ThemedButton } from './themed-button'

describe('ThemedButton', () => {
  it('renders the given title', () => {
    const { getByText } = render(<ThemedButton title="Press me" onPress={jest.fn()} />)
    expect(getByText('Press me')).toBeTruthy()
  })

  it('fires onPress when pressed', () => {
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Click" onPress={onPress} />)
    fireEvent.press(getByText('Click'))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('does not fire onPress when disabled', () => {
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Disabled" onPress={onPress} disabled />)
    fireEvent.press(getByText('Disabled'))
    expect(onPress).not.toHaveBeenCalled()
  })

  it.each([
    ['filled', 'Filled'],
    ['outline', 'Outline'],
    ['ghost', 'Ghost'],
  ] as const)('renders variant %s and still fires onPress', (variant, label) => {
    const onPress = jest.fn()
    const { getByText } = render(
      <ThemedButton title={label} variant={variant} onPress={onPress} />
    )
    expect(getByText(label)).toBeTruthy()
    fireEvent.press(getByText(label))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['filled', 'Filled'],
    ['outline', 'Outline'],
    ['ghost', 'Ghost'],
  ] as const)('disabled %s variant suppresses onPress', (variant, label) => {
    const onPress = jest.fn()
    const { getByText } = render(
      <ThemedButton title={label} variant={variant} onPress={onPress} disabled />
    )
    fireEvent.press(getByText(label))
    expect(onPress).not.toHaveBeenCalled()
  })

  it.each([['small'], ['medium']] as const)('renders %s size', (size) => {
    const { getByText } = render(
      <ThemedButton title={`size-${size}`} size={size} onPress={jest.fn()} />
    )
    expect(getByText(`size-${size}`)).toBeTruthy()
  })
})
