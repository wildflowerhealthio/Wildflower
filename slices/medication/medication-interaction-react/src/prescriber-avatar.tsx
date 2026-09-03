import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './prescriber-avatar.module.css'

/** How many distinct hues a known prescriber can be painted in. */
const paletteSize = 6

/** A small, stable hash of a name into a palette slot, so a doctor keeps one colour. */
const hueIndex = (name: string): number => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0
  return Math.abs(hash) % paletteSize
}

/** Up to two initials: first + last word's first letter (a single word gives one). */
const initialsOf = (name: string): string => {
  const words = name.split(/\s+/).filter((word) => word.length > 0)
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  const initials = (first + last).toUpperCase()
  return initials === '' ? '?' : initials
}

interface PrescriberAvatarProps {
  /** The prescriber's display name (no "Dr." prefix), or `null` when unknown. */
  readonly name: string | null
  /** Draw an accent ring — used to flag a cross-prescriber interaction. */
  readonly ringed?: boolean
}

/**
 * A small initials circle standing in for a prescriber: up to two initials on a
 * colour hashed from the name (stable per doctor), the full "Dr. Name" on hover.
 * An unknown prescriber shows a neutral "?" circle. With `ringed`, an accent
 * ring marks that this prescriber differs from the one the row sits under.
 */
const PrescriberAvatar = ({ name, ringed = false }: PrescriberAvatarProps): JSX.Element => {
  const trimmed = name?.trim() ?? ''
  const known = trimmed.length > 0
  const display = known ? `Dr. ${trimmed}` : 'Prescriber unknown'
  // The ring is a "different prescriber" cue; say so in the label too, so it is
  // not a visual-only signal.
  const label = ringed ? `${display} — different prescriber` : display
  return (
    <span
      className={cn(
        styles['avatar'],
        known ? styles[`hue-${hueIndex(trimmed)}`] : styles['hue-unknown'],
        ringed ? styles['ringed'] : undefined
      )}
      title={label}
      aria-label={label}
      role="img"
    >
      {known ? initialsOf(trimmed) : '?'}
    </span>
  )
}

export { PrescriberAvatar }
export type { PrescriberAvatarProps }
