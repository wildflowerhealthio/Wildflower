import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { ToggleSwitch } from 'react-tundraish'

import styles from './flag-toggle-row.module.css'

interface FlagToggleRowProps {
  /** Plain-language consent copy for the flag (e.g. "Confirm who you are"). */
  readonly label: ReactNode
  /** The literal scope string, shown in mono (e.g. `openid`). */
  readonly code: string
  /** Optional secondary helper line. */
  readonly caption?: ReactNode
  readonly checked: boolean
  /**
   * Disabled — the flag wasn't requested (request mode), so it's shown but not
   * toggleable (`spec.md §2/§7`). A disabled row may omit `onChange`.
   */
  readonly disabled?: boolean
  readonly onChange?: (checked: boolean) => void
  readonly className?: string
}

/**
 * One non-resource (flag) scope as an on/off row — a {@link ToggleSwitch} beside
 * the plain-language consent copy, with the literal scope string in mono. Flag
 * scopes (`openid`, `offline_access`, …) live in their own "Sign-in & app
 * basics" group and never in the resource grid (`spec.md §7`).
 */
const FlagToggleRow = ({
  label,
  code,
  caption,
  checked,
  disabled = false,
  onChange,
  className,
}: FlagToggleRowProps): JSX.Element => {
  const content = (
    <span className={styles['text']}>
      <span className={styles['label']}>{label}</span>
      {caption !== undefined ? <span className={styles['caption']}>{caption}</span> : null}
    </span>
  )
  return (
    <div className={cn(styles['row'], className)}>
      {disabled ? (
        <ToggleSwitch
          className={styles['switch']}
          checked={checked}
          disabled={true}
          label={content}
        />
      ) : (
        <ToggleSwitch
          className={styles['switch']}
          checked={checked}
          label={content}
          onChange={(next) => {
            onChange?.(next)
          }}
        />
      )}
      <code className={styles['code']}>{code}</code>
    </div>
  )
}

export { FlagToggleRow, type FlagToggleRowProps }
