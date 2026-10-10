import { type JSX, useEffect, useRef } from 'react'

import styles from './section-toggle.module.css'

/**
 * A section heading with a tri-state include toggle, shared by every list that
 * shows sections of rows.
 *
 * @packageDocumentation
 */

/** Props for {@link SectionToggle}. */
interface SectionToggleProps {
  /** The section's title, shown as its heading and named in the toggle's label. */
  readonly title: string
  /** The keys this section's rows are identified by. */
  readonly keys: readonly string[]
  /** Whether one row is currently in. */
  readonly isIncluded: (key: string) => boolean
  /** Put every row of the section in, or take every one out. */
  readonly onSetIncluded: (keys: readonly string[], included: boolean) => void
}

/**
 * Checked when every row in the section is included, unchecked when none are,
 * indeterminate in between. Clicking it opts the whole section in or out in one
 * go — out when everything was included, in otherwise.
 *
 * @param props - See {@link SectionToggleProps}
 * @returns The section's heading and its toggle
 *
 * @remarks
 * `indeterminate` is not a React-settable attribute, so it is written onto the
 * input element through a ref after render whenever the mixed state changes.
 */
const SectionToggle = ({
  title,
  keys,
  isIncluded,
  onSetIncluded,
}: SectionToggleProps): JSX.Element => {
  const includedCount = keys.filter((key) => isIncluded(key)).length
  const allIncluded = keys.length > 0 && includedCount === keys.length
  const noneIncluded = includedCount === 0
  const checkbox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (checkbox.current !== null) checkbox.current.indeterminate = !allIncluded && !noneIncluded
  }, [allIncluded, noneIncluded])
  return (
    <label className={styles['section-label']}>
      <input
        ref={checkbox}
        type="checkbox"
        checked={allIncluded}
        aria-label={`Include all in ${title}`}
        onChange={() => {
          onSetIncluded(keys, !allIncluded)
        }}
      />
      <h4 className={styles['section-heading']}>{title}</h4>
    </label>
  )
}

export { SectionToggle }
export type { SectionToggleProps }
