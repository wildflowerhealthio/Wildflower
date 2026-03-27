import { Button, type ButtonProps } from 'react-native'

import { type JSX } from 'react'

export type ThemedButtonProps = ButtonProps & {
  lightColor?: string
  darkColor?: string
  type?: undefined | 'default'
}

export function ThemedButton({ type = 'default', ...rest }: ThemedButtonProps): JSX.Element {
  return <Button {...rest} />
}
