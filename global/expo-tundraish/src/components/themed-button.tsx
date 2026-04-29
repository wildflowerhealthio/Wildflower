import { Match } from 'effect'
import { type JSX } from 'react'
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'

import { useThemeColors } from '../hooks/use-theme-colors.ts'
import { Borders, FontSize, FontWeight, LineHeight, Spacing } from '../theme.ts'

export type ThemedButtonProps = {
  title: string
  variant?: 'filled' | 'outline' | 'ghost'
  size?: 'small' | 'medium'
  disabled?: boolean
  onPress?: () => void
}

export function ThemedButton({
  title,
  variant = 'filled',
  size = 'medium',
  disabled = false,
  onPress,
}: ThemedButtonProps): JSX.Element {
  const { accent, accentPressed, foreground, background, surfacePressed, accentSubtle, textMuted } =
    useThemeColors()

  const sizeStyle = Match.value(size).pipe(
    Match.when('small', () => sizeStyles.small),
    Match.when('medium', () => sizeStyles.medium),
    Match.exhaustive
  )

  const fontSize = Match.value(size).pipe(
    Match.when('small', () => FontSize.sm),
    Match.when('medium', () => FontSize.base),
    Match.exhaustive
  )

  const variantStyles = Match.value({ disabled, variant }).pipe(
    Match.when({ disabled: true, variant: 'filled' }, () => ({
      idle: { backgroundColor: textMuted, borderColor: textMuted } satisfies ViewStyle,
      pressed: { backgroundColor: textMuted, borderColor: textMuted } satisfies ViewStyle,
    })),
    Match.when({ disabled: true, variant: Match.is('outline', 'ghost') }, () => ({
      idle: { backgroundColor: 'transparent', borderColor: 'transparent' } satisfies ViewStyle,
      pressed: { backgroundColor: 'transparent', borderColor: 'transparent' } satisfies ViewStyle,
    })),
    Match.when({ disabled: false, variant: 'filled' }, () => ({
      idle: { backgroundColor: accent, borderColor: accent } satisfies ViewStyle,
      pressed: { backgroundColor: accentPressed, borderColor: accentPressed } satisfies ViewStyle,
    })),
    Match.when({ disabled: false, variant: 'outline' }, () => ({
      idle: { backgroundColor: 'transparent', borderColor: accent } satisfies ViewStyle,
      pressed: { backgroundColor: accentSubtle, borderColor: accentPressed } satisfies ViewStyle,
    })),
    Match.when({ disabled: false, variant: 'ghost' }, () => ({
      idle: { backgroundColor: 'transparent', borderColor: 'transparent' } satisfies ViewStyle,
      pressed: { backgroundColor: surfacePressed, borderColor: 'transparent' } satisfies ViewStyle,
    })),
    Match.exhaustive
  )

  const textColor = Match.value({ disabled, variant }).pipe(
    Match.when({ disabled: Match.any, variant: 'filled' }, () => background),
    Match.when({ disabled: true, variant: Match.is('outline', 'ghost') }, () => textMuted),
    Match.when({ disabled: false, variant: 'outline' }, () => accent),
    Match.when({ disabled: false, variant: 'ghost' }, () => foreground),
    Match.exhaustive
  )

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        sizeStyle,
        pressed ? variantStyles.pressed : variantStyles.idle,
      ]}
    >
      <Text
        style={[
          styles.text,
          { fontSize, lineHeight: fontSize * LineHeight.normal, color: textColor },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: Borders.width,
    borderRadius: Borders.radius,
  },
  text: {
    fontWeight: FontWeight.medium,
  },
})

const sizeStyles = StyleSheet.create({
  small: {
    paddingVertical: Spacing.s1,
    paddingHorizontal: Spacing.s2,
    gap: Spacing.s1,
  },
  medium: {
    paddingVertical: Spacing.s2,
    paddingHorizontal: Spacing.s4,
    gap: Spacing.s2,
  },
})
