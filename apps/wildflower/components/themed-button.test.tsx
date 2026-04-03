import { render } from '@testing-library/react-native'

import { ThemedButton } from './themed-button'

describe('ThemedButton', () => {
  it('should render with the given title', () => {
    // Arrange & Act
    const { getByText } = render(<ThemedButton title="Press me" onPress={jest.fn()} />)

    // Assert
    expect(getByText('Press me')).toBeTruthy()
  })
})
