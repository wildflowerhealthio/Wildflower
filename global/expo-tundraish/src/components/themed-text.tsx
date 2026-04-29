import { StyleSheet, Text, type TextProps } from 'react-native'

import { type JSX } from 'react'
import { useThemeColors } from '../hooks/use-theme-colors.ts'
import { FontSize, FontWeight, LetterSpacing, LineHeight } from '../theme.ts'

type ThemedTextVariant =
  | 'body'
  | 'bodySemiBold'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'label'
  | 'link'
  | 'button'
  | 'mono'

type ThemedTextProps = TextProps & {
  lightTextColor?: string
  darkTextColor?: string
  type?: ThemedTextVariant
}

function ThemedText({
  style,
  lightTextColor,
  darkTextColor,
  type = 'body',
  ...rest
}: ThemedTextProps): JSX.Element {
  const { foreground: color } = useThemeColors({
    foreground: { light: lightTextColor, dark: darkTextColor },
  })

  return <Text style={[{ color }, styles[type], style]} {...rest} />
}

const styles = StyleSheet.create({
  body: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.regular,
    lineHeight: FontSize.base * LineHeight.relaxed,
    letterSpacing: FontSize.base * LetterSpacing.tight,
  },
  bodySemiBold: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    lineHeight: FontSize.base * LineHeight.relaxed,
    letterSpacing: FontSize.base * LetterSpacing.tight,
  },
  heading1: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.medium,
    lineHeight: FontSize.md * LineHeight.relaxed,
    letterSpacing: FontSize.md * LetterSpacing.normal,
  },
  heading2: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.medium,
    lineHeight: FontSize.lg * LineHeight.relaxed,
    letterSpacing: FontSize.lg * LetterSpacing.normal,
  },
  heading3: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.medium,
    lineHeight: FontSize.xl * LineHeight.relaxed,
    letterSpacing: FontSize.xl * LetterSpacing.tight,
  },
  heading4: {
    fontSize: FontSize['3xl'],
    fontWeight: FontWeight.medium,
    lineHeight: FontSize['3xl'] * LineHeight.normal,
    letterSpacing: FontSize['3xl'] * LetterSpacing.tighter,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.regular,
    lineHeight: FontSize.xs * LineHeight.snug,
    letterSpacing: FontSize.xs * LetterSpacing.wider,
    textTransform: 'uppercase',
  },
  link: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    lineHeight: FontSize.base * LineHeight.normal,
    letterSpacing: FontSize.base * LetterSpacing.wide,
  },
  button: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    lineHeight: FontSize.base * LineHeight.normal,
  },
  mono: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.regular,
    lineHeight: FontSize.sm * LineHeight.relaxed,
    fontFamily: 'monospace',
  },
})

styles satisfies Record<ThemedTextVariant, unknown>

export { ThemedText }
export type { ThemedTextProps, ThemedTextVariant }
