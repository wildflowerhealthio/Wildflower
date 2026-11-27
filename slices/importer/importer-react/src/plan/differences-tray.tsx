import { type Difference, RecordChoice } from '@wildflowerhealthio/importer-fundamentals'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Checkbox } from '@wildflowerhealthio/react-tundraish'
import { type DateTime, type HashSet, Match, Option } from 'effect'
import type { JSX } from 'react'

import * as FieldValueText from './field-value-text.ts'
import { FieldValue } from './field-value.tsx'
import * as PlanDifferences from './plan-differences.ts'
import { DIFFERENCES_HEADING, GAINS_WORD, updateWithImportLabel } from './plan-text.ts'
import styles from './differences-tray.module.css'

/** What {@link DifferencesTray} shows and does. */
interface DifferencesTrayProps {
  /** The instant a person's name in use is judged at. */
  readonly now: DateTime.DateTime
  /** The existing record, with what merging into it would change: at least one difference. */
  readonly candidate: PlanDifferences.Candidate
  /** The fields the chosen merge into it takes, while its option is selected; `None` while it is not. */
  readonly fieldsTaken: Option.Option<HashSet.HashSet<string>>
  readonly onChoose: (choice: RecordChoice.Type) => void
}

/**
 * One difference: `field gains value` for a gap it fills, `field kept →
 * incoming` for a value it overwrites, each value as JSON where the two
 * would read alike (`FieldValueText.differenceTextsOf`).
 */
const DifferenceLine = ({
  now,
  candidate,
  difference,
}: {
  readonly now: DateTime.DateTime
  readonly candidate: PlanDifferences.Candidate
  readonly difference: Difference.Type
}): JSX.Element => {
  const { incoming, kept } = candidate.inPlan
  const { field } = difference
  const texts = FieldValueText.differenceTextsOf(now, field, kept, incoming)
  const valueClassName = FieldValueText.isMonospaced(field)
    ? styles['differences-tray__value--mono']
    : null
  return (
    <li className={styles['differences-tray__difference']}>
      <span className={styles['differences-tray__field']}>{field}</span>{' '}
      {Match.value(difference).pipe(
        Match.tag('FillsGap', () => (
          <>
            {GAINS_WORD}{' '}
            <span className={cn(styles['differences-tray__gain'], valueClassName)}>
              <FieldValue text={texts.incoming} />
            </span>
          </>
        )),
        Match.tag('Overwrites', () => (
          <>
            <span className={cn(valueClassName)}>
              <FieldValue text={texts.kept} />
            </span>{' '}
            →{' '}
            <span className={cn(styles['differences-tray__overwrite'], valueClassName)}>
              <FieldValue text={texts.incoming} />
            </span>
          </>
        )),
        Match.exhaustive
      )}
    </li>
  )
}

/**
 * The checkbox that takes the import's differing fields into the existing
 * record: checked when every one is taken, empty when none is, partly
 * checked otherwise. A click takes none when every one is taken (a link),
 * else every one.
 *
 * @remarks
 * It is the parent of a per-field list to come (#1469), so it reads as one.
 */
const UpdateWithImportCheckbox = ({
  candidate,
  fieldsTaken,
  onChoose,
}: {
  readonly candidate: PlanDifferences.Candidate
  readonly fieldsTaken: HashSet.HashSet<string>
  readonly onChoose: (choice: RecordChoice.Type) => void
}): JSX.Element => {
  const { existing, inPlan } = candidate
  const takenShare = PlanDifferences.takenShareOf(inPlan.differences, fieldsTaken)
  const handleChange = (): void => {
    onChoose(
      takenShare.share === 'Every'
        ? RecordChoice.mergeTakingNoField(existing)
        : RecordChoice.mergeTakingEveryField(existing, inPlan.differences)
    )
  }
  return (
    <Checkbox
      className={styles['differences-tray__update']}
      checked={takenShare.share === 'Every'}
      indeterminate={takenShare.share === 'Some'}
      label={updateWithImportLabel(takenShare)}
      onChange={handleChange}
    />
  )
}

/** What the import would change in the existing record, one line per difference. */
const DifferenceList = ({
  now,
  candidate,
  className,
}: {
  readonly now: DateTime.DateTime
  readonly candidate: PlanDifferences.Candidate
  readonly className: string
}): JSX.Element => (
  <ul className={className}>
    {candidate.inPlan.differences.map((difference) => (
      <DifferenceLine
        key={difference.field}
        now={now}
        candidate={candidate}
        difference={difference}
      />
    ))}
  </ul>
)

/**
 * The tray of an existing record's option that the import differs from:
 * while the option is not selected, the heading "Differences" over what the
 * import would change; once it is, the checkbox that takes those changes,
 * over the same list.
 */
const DifferencesTray = ({
  now,
  candidate,
  fieldsTaken,
  onChoose,
}: DifferencesTrayProps): JSX.Element =>
  fieldsTaken.pipe(
    Option.map((fields) => (
      <>
        <UpdateWithImportCheckbox candidate={candidate} fieldsTaken={fields} onChoose={onChoose} />
        <DifferenceList
          now={now}
          candidate={candidate}
          className={cn(
            styles['differences-tray__list'],
            styles['differences-tray__list--under-update']
          )}
        />
      </>
    )),
    Option.getOrElse(() => (
      <>
        <p className={styles['differences-tray__heading']}>{DIFFERENCES_HEADING}</p>
        <DifferenceList
          now={now}
          candidate={candidate}
          className={styles['differences-tray__list']}
        />
      </>
    ))
  )

export { DifferencesTray }
export type { DifferencesTrayProps }
