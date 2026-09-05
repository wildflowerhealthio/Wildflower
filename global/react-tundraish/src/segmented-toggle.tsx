import type { JSX } from 'react'

import styles from './segmented-toggle.module.css'

/** One option in a {@link SegmentedToggle}. */
interface SegmentedToggleOption<T extends string> {
  readonly value: T
  readonly label: string
}

interface SegmentedToggleProps<T extends string> {
  readonly value: T
  readonly options: readonly SegmentedToggleOption<T>[]
  readonly onChange: (value: T) => void
  /** Accessible name announced for the group (e.g. "View"). */
  readonly 'aria-label': string
}

/**
 * A pill-shaped, one-of-N view toggle: a `role="group"` of `aria-pressed`
 * buttons, the pressed one painted in the accent. Native `<button>`s, so
 * Tab / Space work without any keyboard handler; `aria-pressed` (not
 * `aria-selected`) is the semantic — each button is an independent action
 * that latches on, not an option within a tablist.
 */
const SegmentedToggle = <T extends string>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: SegmentedToggleProps<T>): JSX.Element => (
  <div className={styles['tabs']} role="group" aria-label={ariaLabel}>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        className={styles['tab']}
        aria-pressed={option.value === value}
        onClick={() => {
          onChange(option.value)
        }}
      >
        {option.label}
      </button>
    ))}
  </div>
)

export { SegmentedToggle, type SegmentedToggleOption, type SegmentedToggleProps }
