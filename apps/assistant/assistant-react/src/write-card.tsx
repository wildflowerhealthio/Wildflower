import { WriteProposal } from '@wildflowerhealthio/assistant-core-js'
import { type FieldDiff, formatPath, formatSlot } from '@wildflowerhealthio/fhir-r4/clients'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Match, Option, String as Str } from 'effect'
import { type ComponentProps, type JSX, useId, useState } from 'react'

import styles from './write-card.module.css'

/** The word each kind of field change is shown with. */
const FIELD_CHANGE_LABEL: Readonly<Record<WriteProposal.FieldChange, string>> = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
}

/** A new record's fields, one line each: its name and its value as JSON. */
const NewRecordFields = ({
  resource,
}: {
  readonly resource: Readonly<Record<string, unknown>>
}): JSX.Element => (
  <ul className={styles['write-card__fields']} aria-label="New record">
    {Object.entries(resource)
      .filter(([name]) => name !== 'resourceType')
      .map(([name, value]) => (
        <li key={name} className={styles['write-card__field']}>
          <code className={styles['write-card__path']}>{name}</code>
          <span className={styles['write-card__value']}>
            {formatSlot({ _tag: 'value', value })}
          </span>
        </li>
      ))}
  </ul>
)

/** An update's changes, one line per field: added, changed or removed, and what it was and will be. */
const ChangedFields = ({ fields }: { readonly fields: readonly FieldDiff[] }): JSX.Element => (
  <ul className={styles['write-card__fields']} aria-label="Changes">
    {fields.map((field) => {
      const path = formatPath(field.path)
      const change = WriteProposal.fieldChangeOf(field)
      return (
        <li key={path} className={styles['write-card__field']}>
          <span className={cn('text-label-4', styles[`write-card__change--${change}`])}>
            {FIELD_CHANGE_LABEL[change]}
          </span>
          <code className={styles['write-card__path']}>{path}</code>
          <span className={styles['write-card__value']}>{formatSlot(field.server)}</span>
          <span className={styles['write-card__arrow']} aria-hidden="true">
            →
          </span>
          <span className={styles['write-card__value']}>{formatSlot(field.incoming)}</span>
        </li>
      )
    })}
  </ul>
)

/**
 * Approve and Decline; Decline opens an optional reason, above the buttons,
 * and asks again before declining.
 */
const WriteCardActions = ({
  onDecide,
}: {
  readonly onDecide: (decision: WriteProposal.Decision) => void
}): JSX.Element => {
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const reasonDomId = useId()
  if (!declining) {
    return (
      <div className={styles['write-card__actions']}>
        <button
          type="button"
          className="button-2 outline accent-red"
          onClick={() => {
            setDeclining(true)
          }}
        >
          Decline
        </button>
        <button
          type="button"
          className="button-2 filled"
          onClick={() => {
            onDecide({ kind: 'approved' })
          }}
        >
          Approve
        </button>
      </div>
    )
  }
  return (
    <>
      <div className={styles['write-card__reason']}>
        <label htmlFor={reasonDomId} className="text-label-3">
          Reason (optional)
        </label>
        <textarea
          id={reasonDomId}
          className="input-3"
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.currentTarget.value)
          }}
        />
      </div>
      <div className={styles['write-card__actions']}>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            setDeclining(false)
          }}
        >
          Back
        </button>
        <button
          type="button"
          className="button-2 filled accent-red"
          onClick={() => {
            onDecide({
              kind: 'declined',
              reason: Option.some(reason.trim()).pipe(Option.filter(Str.isNonEmpty)),
            })
          }}
        >
          Decline change
        </button>
      </div>
    </>
  )
}

/** What the card says once `decision` is made, while the round finishes. */
const decisionTextOf = (decision: WriteProposal.Decision): string =>
  Match.value(decision).pipe(
    Match.when({ kind: 'approved' }, () => 'Approved. Saving…'),
    Match.when({ kind: 'declined' }, () => 'Declined.'),
    Match.exhaustive
  )

/** Props for {@link WriteCard}: the proposal, the decision on it if made, and any other `<section>` prop. */
interface WriteCardProps extends Omit<ComponentProps<'section'>, 'children'> {
  readonly proposal: WriteProposal.Type
  /** The person's decision; `None` until they make it. */
  readonly decision: Option.Option<WriteProposal.Decision>
  readonly onDecide: (decision: WriteProposal.Decision) => void
}

/**
 * A write Claude proposed, for the person to approve or decline: a line
 * saying what it would do ("Update Observation/o1, 2 fields"), then the new
 * record's fields or the change field by field, the whole resource as JSON
 * folded away, and Approve / Decline. Declining asks for an optional reason
 * first. Once decided, the buttons give way to the decision.
 */
const WriteCard = ({
  proposal,
  decision,
  onDecide,
  className,
  ...rootProps
}: WriteCardProps): JSX.Element => {
  const summary = WriteProposal.summaryOf(proposal)
  return (
    <section {...rootProps} aria-label={summary} className={cn(styles['write-card'], className)}>
      <p className={cn('text-label-2', styles['write-card__summary'])}>{summary}</p>
      <div className="text-body-3">
        {Match.value(proposal).pipe(
          Match.when({ kind: 'create' }, ({ resource }) => <NewRecordFields resource={resource} />),
          Match.when({ kind: 'update' }, ({ fields }) => <ChangedFields fields={fields} />),
          Match.exhaustive
        )}
      </div>
      <details className={styles['write-card__json']}>
        <summary className="text-label-3">JSON</summary>
        <pre className={cn('text-body-3', styles['write-card__json-text'])}>
          {JSON.stringify(proposal.resource, null, 2)}
        </pre>
      </details>
      {decision.pipe(
        Option.map((made) => (
          <p
            key="decision"
            role="status"
            className={cn('text-body-3', styles['write-card__decision'])}
          >
            {decisionTextOf(made)}
          </p>
        )),
        Option.getOrNull
      )}
      {Option.isNone(decision) ? <WriteCardActions onDecide={onDecide} /> : null}
    </section>
  )
}

export { WriteCard }
export type { WriteCardProps }
