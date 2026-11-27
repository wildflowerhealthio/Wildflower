import type { RecordChoice } from '@wildflowerhealthio/importer-fundamentals'
import { Chip, RecordRow } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import { type JSX, useRef } from 'react'
import { flushSync } from 'react-dom'

import * as PlanSections from './plan-sections.ts'
import { CHANGED_CHIP, onImportLabel, SELECT_PLACEHOLDER } from './plan-text.ts'
import { type RowOptionValue, rowOptionsOf, selectedValueOf } from './row-options.ts'
import { RowDetail } from './row-text.ts'
import styles from './plan-record-row.module.css'

/** What {@link PlanRecordRow} shows and does. */
interface PlanRecordRowProps {
  readonly row: PlanSections.Row
  /** The row's last line: its reason tag, and what its section adds to it. */
  readonly reasonLine: string
  readonly onChoose: (choice: RecordChoice.Type) => void
  /** Clear the reviewer's choice, back to the suggestion. */
  readonly onReset: () => void
}

/** A row's detail: its text, or an identifier's value in mono. */
const RowDetailText = ({ detail }: { readonly detail: RowDetail }): JSX.Element =>
  RowDetail.$match(detail, {
    Text: ({ text }) => <>{text}</>,
    Identifier: ({ value }) => (
      <span className={styles['plan-record-row__identifier']}>{value}</span>
    ),
  })

/**
 * One record decided automatically: its title, with a Changed chip once the
 * reviewer changed its choice, its detail, its reason line, and its choice:
 * use one of its existing records, save it as a new record, or don't add it.
 * Reset is offered only for a changed row; it takes itself away, so once the
 * row is back to its suggestion, focus moves to the row's choice.
 */
const PlanRecordRow = ({ row, reasonLine, onChoose, onReset }: PlanRecordRowProps): JSX.Element => {
  const options = rowOptionsOf(row)
  const isChanged = PlanSections.isChanged(row)
  const rowRef = useRef<HTMLDivElement>(null)
  const handleReset = (): void => {
    // The Reset link takes itself away: commit the reset now, then focus the
    // row's choice, so focus is not left on nothing.
    flushSync(onReset)
    rowRef.current?.querySelector('select')?.focus()
  }
  const handleChoose = (value: RowOptionValue): void => {
    const picked = options.find((option) => option.value === value)
    if (picked !== undefined) onChoose(picked.choice)
  }
  return (
    <RecordRow
      ref={rowRef}
      title={row.title}
      badge={isChanged ? <Chip>{CHANGED_CHIP}</Chip> : null}
      detail={<RowDetailText detail={row.detail} />}
      reason={reasonLine}
      choices={options}
      choice={Option.getOrNull(
        selectedValueOf(
          row.resolved.planned,
          row.candidates.map(({ candidate }) => candidate)
        )
      )}
      placeholder={SELECT_PLACEHOLDER}
      onChoose={handleChoose}
      choiceLabel={onImportLabel(row.title)}
      onReset={isChanged ? handleReset : undefined}
    />
  )
}

export { PlanRecordRow }
export type { PlanRecordRowProps }
