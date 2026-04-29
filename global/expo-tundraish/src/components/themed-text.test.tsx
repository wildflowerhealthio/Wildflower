import { render } from '@testing-library/react-native'

import { ThemedText, type ThemedTextVariant } from './themed-text'

const ALL_VARIANTS: readonly ThemedTextVariant[] = [
  'body',
  'bodySemiBold',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'label',
  'link',
  'button',
  'mono',
] as const

describe('ThemedText', () => {
  it.each(ALL_VARIANTS)('renders children for variant %s', (variant) => {
    const { getByText } = render(<ThemedText type={variant}>{`text-${variant}`}</ThemedText>)
    expect(getByText(`text-${variant}`)).toBeTruthy()
  })

  it('defaults to body when no type is provided', () => {
    const { getByText } = render(<ThemedText>default</ThemedText>)
    expect(getByText('default')).toBeTruthy()
  })

  it('forwards arbitrary text props', () => {
    const { getByText } = render(
      <ThemedText accessibilityLabel="hello-label">hello</ThemedText>
    )
    expect(getByText('hello').props.accessibilityLabel).toBe('hello-label')
  })
})
