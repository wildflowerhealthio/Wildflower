import { render } from '@testing-library/react-native'
import { ActivityIndicator } from 'react-native'

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
})
