import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ChangeEvent, ComponentProps, JSX, ReactNode } from 'react'

import { LinkButton } from './link-button.tsx'
import styles from './record-row.module.css'

/**
 * The colour a {@link RecordRow}'s choice wears while it is picked: `success`
 * for a choice that adds to an existing record. Warning is not offered: it is
 * the row's own tone while nothing is picked.
 */
type RecordRowTone = 'accent' | 'success' | 'neutral' | 'muted'

/** One option in a {@link RecordRow}'s choice. */
interface RecordRowChoice<T extends string> {
  readonly value: T
  readonly label: string
  readonly tone: RecordRowTone
  readonly disabled?: boolean
}

/**
 * Props for {@link RecordRow}: its three lines, its choice, and any other
 * `<div>` prop, which go to the row. While `choice` is `null`, or names no
 * option in `choices`, `placeholder` fills the choice and the row wears the
 * warning tone.
 */
type RecordRowProps<T extends string> = Omit<
  ComponentProps<'div'>,
  'children' | 'title' | 'onChange'
> & {
  readonly title: ReactNode
  /** Chips beside the title ("Changed", "Edited"). */
  readonly badge?: ReactNode
  /** The record's own detail, under the title (`subject: Tyra Ashford · requester: Dr. Brown`). */
  readonly detail: ReactNode
  /** Why the row has the choice it has, as a short tag on the last line. */
  readonly reason: ReactNode
  readonly choices: readonly RecordRowChoice<T>[]
  readonly choice: T | null
  /** Fills the choice while nothing in `choices` is picked ("Select…"). */
  readonly placeholder: string
  readonly onChoose: (value: T) => void
  /** Accessible name for the choice (`On import: Tyra Ashford`). */
  readonly choiceLabel: string
  /** Makes the text a button, for opening the record. */
  readonly onOpen?: () => void
  /** Shows a Reset link before the choice, for a row the reader has changed. */
  readonly onReset?: () => void
}

/**
 * A row for one record: a title with optional chips, a detail line and a
 * reason tag, with a native `<select>` of what to do with it at the end,
 * coloured by the picked option's tone. Below 768px the select drops under
 * the text at full width.
 */
const RecordRow = <T extends string>({
  title,
  badge,
  detail,
  reason,
  choices,
  choice,
  placeholder,
  onChoose,
  choiceLabel,
  onOpen,
  onReset,
  className,
  ...rootProps
}: RecordRowProps<T>): JSX.Element => {
  const picked = choices.find((option) => option.value === choice)
  const lines = (
    <>
      <span className={styles['record-row__title']}>
        <span>{title}</span>
        {badge}
      </span>
      <span className={styles['record-row__detail']}>{detail}</span>
      <span className={styles['record-row__reason']}>{reason}</span>
    </>
  )
  const handleChoiceChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = choices.find((option) => option.value === event.target.value)
    if (next !== undefined) onChoose(next.value)
  }
  return (
    <div {...rootProps} className={cn(styles['record-row'], className)}>
      {onOpen === undefined ? (
        <div className={styles['record-row__text']}>{lines}</div>
      ) : (
        <button type="button" className={styles['record-row__text']} onClick={onOpen}>
          {lines}
        </button>
      )}
      {onReset === undefined ? null : (
        <LinkButton className={styles['record-row__reset']} onClick={onReset}>
          Reset
        </LinkButton>
      )}
      <span
        className={cn(
          styles['record-row__choice'],
          styles[`record-row__choice--${picked?.tone ?? 'warning'}`]
        )}
      >
        <select
          className={styles['record-row__select']}
          aria-label={choiceLabel}
          value={picked?.value ?? ''}
          onChange={handleChoiceChange}
        >
          {picked === undefined ? (
            <option value="" disabled={true}>
              {placeholder}
            </option>
          ) : null}
          {choices.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          className={styles['record-row__chevron']}
          viewBox="0 0 24 24"
          width="18"
          height="18"
        >
          <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" />
        </svg>
      </span>
    </div>
  )
}

export { RecordRow, type RecordRowChoice, type RecordRowProps, type RecordRowTone }
