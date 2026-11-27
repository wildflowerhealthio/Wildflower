import { type FhirResource, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import {
  ImportedRecord,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
} from '@wildflowerhealthio/importer-fundamentals'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { RadioCard, RadioCardGroup } from '@wildflowerhealthio/react-tundraish'
import { DateTime, type HashSet, Match, Option } from 'effect'
import { type JSX, type ReactNode, useId } from 'react'

import { DifferencesTray } from './differences-tray.tsx'
import * as FieldValueText from './field-value-text.ts'
import { FieldValue } from './field-value.tsx'
import * as PlanDifferences from './plan-differences.ts'
import {
  ADDS_IDENTIFIER_LEAD,
  DecisionMatches,
  decisionMetaLine,
  DONT_ADD_LABEL,
  dontAddOutcome,
  existingKicker,
  IMPORTED_KICKER,
  KICKER_SEPARATOR,
  SAVE_AS_NEW_LABEL,
  saveAsNewOutcome,
  selectRecordLead,
  selectRecordTitle,
  USE_EXISTING_LABEL,
  existingRecordOutcome,
} from './plan-text.ts'
import * as RecordText from './record-text.ts'
import styles from './decision-card.module.css'

/** What {@link DecisionCard} shows and does. */
interface DecisionCardProps {
  /** The record that needs a decision. */
  readonly planned: PlannedRecord.Type
  /** The instant a person's name in use is judged at. */
  readonly now: DateTime.DateTime
  /** How many records of the import reference it. */
  readonly referrers: number
  /** The existing records it could merge into, with what merging into each would change. */
  readonly candidates: readonly PlanDifferences.Candidate[]
  /** The card's DOM id, which the import bar scrolls to. */
  readonly domId: string
  /** Whether the write is in flight: every control is disabled until it settles. */
  readonly importing: boolean
  readonly onChoose: (choice: RecordChoice.Type) => void
}

/** One field an option shows: its value in that option's resource, and whether it is one of that option's differences. */
interface FieldRow {
  readonly field: string
  /** The value as text; `None` when the resource has no value for it. */
  readonly text: Option.Option<FieldValueText.FieldText>
  readonly differs: boolean
}

/**
 * The imported record's row for each of `fields`: its value as text, or as
 * JSON where it reads alike with a candidate's value it differs from.
 */
const importedRowsOf = (
  now: DateTime.DateTime,
  fields: readonly string[],
  incoming: FhirResource,
  candidates: readonly PlanDifferences.Candidate[]
): readonly FieldRow[] =>
  fields.map((field) => ({
    field,
    text: candidates.some(
      (candidate) =>
        PlanDifferences.differsOn(candidate, field) &&
        FieldValueText.readAlike(now, field, candidate.inPlan.kept, incoming)
    )
      ? FieldValueText.jsonOf(incoming, field)
      : FieldValueText.textOf(now, incoming, field),
    differs: false,
  }))

/**
 * An existing record's row for each of `fields`: its value as kept, marked
 * when the field is one of its differences, then shown so it reads apart
 * from the imported record's (`FieldValueText.differenceTextsOf`).
 */
const existingRowsOf = (
  now: DateTime.DateTime,
  fields: readonly string[],
  candidate: PlanDifferences.Candidate
): readonly FieldRow[] =>
  fields.map((field) => {
    const { kept, incoming } = candidate.inPlan
    const differs = PlanDifferences.differsOn(candidate, field)
    return {
      field,
      text: differs
        ? FieldValueText.differenceTextsOf(now, field, kept, incoming).kept
        : FieldValueText.textOf(now, kept, field),
      differs,
    }
  })

/** An inline file title or identifier, on the sunken surface. */
const Code = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <code className={styles['decision-card__code']}>{children}</code>
)

/**
 * An option's kicker: its parts joined by " · ", each kept whole, so a line
 * breaks only between parts.
 */
const Kicker = ({ parts }: { readonly parts: readonly ReactNode[] }): JSX.Element => (
  <span className={styles['decision-card__kicker']}>
    {parts.map((part, index) => (
      // The parts are fixed for the option, in a fixed order.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index}>
        {index === 0 ? null : KICKER_SEPARATOR}
        <span className={styles['decision-card__kicker-part']}>{part}</span>
      </span>
    ))}
  </span>
)

/** An option's body: its kicker, its title, one row per field the options differ on, and any notes. */
const OptionBody = ({
  kicker,
  title,
  rows,
  notes,
}: {
  readonly kicker: readonly ReactNode[]
  readonly title: string
  readonly rows: readonly FieldRow[]
  readonly notes: ReactNode
}): JSX.Element => (
  <>
    <div className={styles['decision-card__option-heading']}>
      <Kicker parts={kicker} />
      <span className={styles['decision-card__option-title']}>{title}</span>
    </div>
    {rows.length === 0 ? null : (
      <dl className={styles['decision-card__fields']}>
        {rows.map(({ field, text, differs }) => (
          <div key={field} className={styles['decision-card__field']}>
            <dt className={styles['decision-card__field-name']}>{field}</dt>
            <dd
              className={cn(
                styles['decision-card__field-value'],
                Option.isNone(text) && styles['decision-card__field-value--not-recorded'],
                differs && Option.isSome(text) && styles['decision-card__field-value--differs'],
                FieldValueText.isMonospaced(field) && styles['decision-card__field-value--mono']
              )}
            >
              <FieldValue text={text} />
            </dd>
          </div>
        ))}
      </dl>
    )}
    {notes}
  </>
)

/** When `resource` was last updated, `YYYY-MM-DD` in UTC; `None` when it does not say. */
const updatedOnOf = (resource: FhirResource): Option.Option<string> =>
  Option.fromNullable(resource.meta).pipe(
    Option.flatMapNullable(({ lastUpdated }) => lastUpdated),
    Option.map(DateTime.formatIsoDateUtc)
  )

/** The option of one existing record: use it, its differences in its tray. */
const ExistingOption = ({
  name,
  now,
  candidate,
  fields,
  fieldsTaken,
  referrers,
  onChoose,
}: {
  readonly name: string
  readonly now: DateTime.DateTime
  readonly candidate: PlanDifferences.Candidate
  readonly fields: readonly string[]
  /** The fields the chosen merge into it takes, while it is selected; `None` while it is not. */
  readonly fieldsTaken: Option.Option<HashSet.HashSet<string>>
  readonly referrers: number
  readonly onChoose: (choice: RecordChoice.Type) => void
}): JSX.Element => {
  const { existing, knownBy, inPlan } = candidate
  const taken = Option.map(fieldsTaken, (fieldsTakenNow) =>
    PlanDifferences.takenAmong(inPlan.differences, fieldsTakenNow)
  )
  const handleSelect = (): void => {
    onChoose(RecordChoice.mergeFillingGaps(existing, inPlan.differences))
  }
  return (
    <RadioCard
      name={name}
      value={literalReferenceOf(existing)}
      checked={Option.isSome(fieldsTaken)}
      onSelect={handleSelect}
      label={USE_EXISTING_LABEL}
      outcome={Option.getOrUndefined(
        Option.flatMap(taken, (fieldsUpdated) =>
          existingRecordOutcome({ referrers, fieldsUpdated })
        )
      )}
      tray={
        inPlan.differences.length === 0 ? undefined : (
          <DifferencesTray
            now={now}
            candidate={candidate}
            fieldsTaken={fieldsTaken}
            onChoose={onChoose}
          />
        )
      }
      trayTone={Option.exists(taken, (count) => count > 0) ? 'success' : 'neutral'}
    >
      <OptionBody
        kicker={existingKicker({ updatedOn: updatedOnOf(existing), knownBy })}
        title={RecordText.titleOfResource(now, inPlan.kept)}
        rows={existingRowsOf(now, fields, candidate)}
        notes={PlanDifferences.identifiersAddedBy(candidate).map(({ system, value }) => (
          <p key={`${system}|${value}`} className={styles['decision-card__note']}>
            {ADDS_IDENTIFIER_LEAD} <Code>{value}</Code>
          </p>
        ))}
      />
    </RadioCard>
  )
}

/**
 * Why `planned` needs a decision, counted for its meta line: the existing
 * records that carry its identifier (`StoredMatch.storedCopiesOf`) when
 * several do, else the search's candidates and the identity fields none of
 * them differs on.
 */
const matchesOf = (
  planned: PlannedRecord.Type,
  candidates: readonly PlanDifferences.Candidate[]
): DecisionMatches =>
  Match.value(planned.suggestion.reason).pipe(
    Match.tag('SeveralIdentifierMatches', () =>
      DecisionMatches.IdentifierMatches({
        count: StoredMatch.storedCopiesOf(planned.storedMatch).length,
      })
    ),
    Match.orElse(() =>
      DecisionMatches.NameMatches({
        count: planned.storedMatch.candidates.length,
        sameFields: PlanDifferences.sameIdentityFieldsOf(
          RecordText.statedIdentityFieldsOf(PlannedRecord.reviewedResourceOf(planned)),
          candidates
        ),
      })
    )
  )

/**
 * One record that needs a decision: its title and what is known of it, then
 * one option per way to import it, side by side: save it as a new record,
 * use one of the existing records it could merge into, or, on a line of its
 * own, don't add it. Its edge is the warning colour while nothing is chosen.
 *
 * @remarks
 * Each option shows the fields the options differ on, an existing record's
 * value bold where the field is one of its differences, and as JSON where
 * it would read alike with the imported record's though it differs; `name`
 * is the option's title and never a row. While the write is in flight every
 * control is disabled (one `<fieldset disabled>`). Using an existing record takes the fields that fill a gap
 * in it and none that overwrite one.
 */
const DecisionCard = ({
  planned,
  now,
  referrers,
  candidates,
  domId,
  importing,
  onChoose,
}: DecisionCardProps): JSX.Element => {
  const radioName = useId()
  const titleDomId = useId()
  const { record } = planned
  const choice = PlannedRecord.effectiveChoice(planned)
  const isOpen = Option.isNone(choice)
  const incoming = PlannedRecord.reviewedResourceOf(planned)
  const title = RecordText.titleOf(now, record)
  const fileTitle = RecordText.fileTitleOf(record)
  const resourceType = ImportedRecord.resourceTypeOf(record)
  const fields = PlanDifferences.differingFieldsOf(candidates).filter((field) => field !== 'name')
  const isSaveAsNew = Option.exists(choice, RecordChoice.is('SaveAsNewRecord'))
  const isDontAdd = Option.exists(choice, RecordChoice.is('DontAdd'))
  const handleSaveAsNew = (): void => {
    onChoose(RecordChoice.SaveAsNewRecord())
  }
  const handleDontAdd = (): void => {
    onChoose(RecordChoice.DontAdd())
  }
  return (
    <section
      id={domId}
      aria-labelledby={titleDomId}
      className={cn(styles['decision-card'], isOpen && styles['decision-card--open'])}
    >
      <div className={styles['decision-card__heading']}>
        <h3 id={titleDomId} className={styles['decision-card__title']}>
          {selectRecordLead({ resourceType, title })} <Code>{fileTitle}</Code>
        </h3>
        <p
          className={cn(
            styles['decision-card__meta'],
            isOpen && styles['decision-card__meta--open']
          )}
        >
          {decisionMetaLine({
            isOpen,
            matches: matchesOf(planned, candidates),
            referrers,
          })}
        </p>
      </div>
      <fieldset disabled={importing} className={styles['decision-card__options']}>
        <RadioCardGroup aria-label={selectRecordTitle({ resourceType, title, fileTitle })}>
          <RadioCard
            name={radioName}
            value="save-as-new"
            checked={isSaveAsNew}
            onSelect={handleSaveAsNew}
            label={SAVE_AS_NEW_LABEL}
            variant="dashed"
            outcome={Option.getOrUndefined(
              Option.filter(saveAsNewOutcome(referrers), () => isSaveAsNew)
            )}
          >
            <OptionBody
              kicker={[IMPORTED_KICKER, <Code key="file">{fileTitle}</Code>]}
              title={title}
              rows={importedRowsOf(now, fields, incoming, candidates)}
              notes={null}
            />
          </RadioCard>
          {candidates.map((candidate) => (
            <ExistingOption
              key={literalReferenceOf(candidate.existing)}
              name={radioName}
              now={now}
              candidate={candidate}
              fields={fields}
              fieldsTaken={PlanDifferences.fieldsTakenInto(choice, candidate.existing)}
              referrers={referrers}
              onChoose={onChoose}
            />
          ))}
          <label className={cn('radio-row', styles['decision-card__dont-add'])}>
            <input
              type="radio"
              className="radio-3"
              name={radioName}
              value="dont-add"
              checked={isDontAdd}
              onChange={handleDontAdd}
            />
            <span>{DONT_ADD_LABEL}</span>
            {dontAddOutcome({ referrers, title }).pipe(
              Option.filter(() => isDontAdd),
              Option.map((outcome) => (
                <span key="outcome" className={styles['decision-card__dont-add-outcome']}>
                  · {outcome}
                </span>
              )),
              Option.getOrNull
            )}
          </label>
        </RadioCardGroup>
      </fieldset>
    </section>
  )
}

export { DecisionCard }
export type { DecisionCardProps }
