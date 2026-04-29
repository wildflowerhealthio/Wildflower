import { render } from '@testing-library/react-native'
import { Text } from 'react-native'

import { ThemedView } from './themed-view'

describe('ThemedView', () => {
  it('renders children', () => {
    const { getByText } = render(
      <ThemedView>
        <Text>inside</Text>
      </ThemedView>
    )
    expect(getByText('inside')).toBeTruthy()
  })

  it('forwards arbitrary view props', () => {
    const { getByTestId } = render(<ThemedView testID="themed-view-id" />)
    expect(getByTestId('themed-view-id')).toBeTruthy()
  })
})
