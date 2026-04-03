import { render, fireEvent } from '@testing-library/react-native'

import { ThemedButton } from './themed-button'

describe('ThemedButton', () => {
  it('should render with the given title', () => {
    // Arrange & Act
    const { getByText } = render(<ThemedButton title="Press me" onPress={jest.fn()} />)

    // Assert
    expect(getByText('Press me')).toBeTruthy()
  })

  it('should fire onPress when pressed', () => {
    // Arrange
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Click" onPress={onPress} />)

    // Act
    fireEvent.press(getByText('Click'))

    // Assert
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('should render with type="default"', () => {
    // Arrange & Act
    const { getByText } = render(
      <ThemedButton title="Default" type="default" onPress={jest.fn()} />
    )

    // Assert
    expect(getByText('Default')).toBeTruthy()
  })

  it('should render with undefined type (defaults to "default")', () => {
    // Arrange & Act
    const { getByText } = render(<ThemedButton title="No type" onPress={jest.fn()} />)

    // Assert
    expect(getByText('No type')).toBeTruthy()
  })

  it('should not fire onPress when disabled', () => {
    // Arrange
    const onPress = jest.fn()
    const { getByText } = render(<ThemedButton title="Disabled" onPress={onPress} disabled />)

    // Act
    fireEvent.press(getByText('Disabled'))

    // Assert
    expect(onPress).not.toHaveBeenCalled()
  })
})
