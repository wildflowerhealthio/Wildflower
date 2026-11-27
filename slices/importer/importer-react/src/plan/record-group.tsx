import { RecordChoice, type RecordKey } from '@wildflowerhealthio/importer-fundamentals'
import { Menu, type MenuItem } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useState } from 'react'

import { recordKeyText } from './decision-card-ids.ts'
import { PlanRecordRow } from './plan-record-row.tsx'
import * as PlanSections from './plan-sections.ts'
import {
  createAllLabel,
  DONT_ADD_ANY_LABEL,
  HIDE_LABEL,
  recordGroupHeading,
  recordGroupLine,
  RESET_TO_SUGGESTED_LABEL,
  sameAsExistingLine,
  setEveryLabel,
  SHOW_LABEL,
  showMoreLabel,
} from './plan-text.ts'
import styles from './record-group.module.css'

/** What {@link RecordGroup} shows and does. */
interface RecordGroupProps {
  readonly group: PlanSections.Group
  /** Which section it is in: a file set's groups offer to set every record of the group at once. */
  readonly sectionTag: PlanSections.Section['_tag']
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
}

/**
 * The rows of one FHIR resource type in a section: its heading, counting
 * every row, its status line, and, in a file set's section, a menu that
 * sets every record of the group, folded ones included; then the listed
 * rows, the first {@link PlanSections.FIRST_PAGE_SIZE} and more on "Show
 * more", then a line that shows and hides the rows the same as existing
 * ones, folded under it.
 *
 * @remarks
 * How many listed rows are shown and whether the fold is open are this
 * component's own state, so they survive a choice: the group is keyed by
 * its type within its section. Its rows, "Show more" and the fold line are
 * one keyed list, so a row keeps its element, and its select its focus,
 * when a choice moves it between the folded and the listed rows.
 */
const RecordGroup = ({ group, sectionTag, onChoose, onReset }: RecordGroupProps): JSX.Element => {
  const [shown, setShown] = useState(PlanSections.FIRST_PAGE_SIZE)
  const [isUnfolded, setUnfolded] = useState(false)
  const keys = PlanSections.keysOf(group)
  const heading = recordGroupHeading(group.resourceType, keys.length)
  const page = PlanSections.listedPageOf(group, shown)
  const menuItems: readonly MenuItem[] = [
    {
      id: 'create-all',
      label: createAllLabel(keys.length),
      onSelect: () => {
        onChoose(keys, RecordChoice.SaveAsNewRecord())
      },
    },
    {
      id: 'reset',
      label: RESET_TO_SUGGESTED_LABEL,
      onSelect: () => {
        onReset(keys)
      },
    },
    {
      id: 'dont-add-any',
      label: DONT_ADD_ANY_LABEL,
      destructive: true,
      onSelect: () => {
        onChoose(keys, RecordChoice.DontAdd())
      },
    },
  ]
  const handleShowMore = (): void => {
    setShown((previous) => previous + PlanSections.PAGE_SIZE)
  }
  const handleToggleFold = (): void => {
    setUnfolded((previous) => !previous)
  }
  const rowItem = (row: PlanSections.Row): JSX.Element => {
    const { key } = row.resolved.planned.record
    return (
      <li key={recordKeyText(key)} className={styles['record-group__item']}>
        <PlanRecordRow
          row={row}
          reasonLine={PlanSections.reasonLineOf(sectionTag, row)}
          onChoose={(choice) => {
            onChoose([key], choice)
          }}
          onReset={() => {
            onReset([key])
          }}
        />
      </li>
    )
  }
  const showMoreItem = (
    <li key="show-more" className={styles['record-group__item']}>
      <button type="button" className={styles['record-group__more']} onClick={handleShowMore}>
        {showMoreLabel(page.more)}
      </button>
    </li>
  )
  const foldItem = (
    <li key="fold" className={styles['record-group__item']}>
      <button
        type="button"
        className={styles['record-group__fold']}
        aria-expanded={isUnfolded}
        onClick={handleToggleFold}
      >
        <span className={styles['record-group__fold-line']}>
          {sameAsExistingLine(group.folded.length)}
        </span>
        <span className={styles['record-group__fold-action']}>
          {isUnfolded ? HIDE_LABEL : SHOW_LABEL}
        </span>
      </button>
    </li>
  )
  return (
    <div className={styles['record-group']}>
      <div className={styles['record-group__heading']}>
        <span className={styles['record-group__titles']}>
          <h4 className={styles['record-group__title']}>{heading}</h4>
          <span className={styles['record-group__line']}>{recordGroupLine(group.counts)}</span>
        </span>
        {sectionTag === 'FileSet' ? (
          <Menu label={setEveryLabel(group.resourceType)} items={menuItems} />
        ) : null}
      </div>
      <ul className={styles['record-group__rows']}>
        {[
          ...page.rows.map(rowItem),
          ...(page.more === 0 ? [] : [showMoreItem]),
          ...(group.folded.length === 0 ? [] : [foldItem]),
          ...(isUnfolded ? group.folded.map(rowItem) : []),
        ]}
      </ul>
    </div>
  )
}

export { RecordGroup }
export type { RecordGroupProps }
