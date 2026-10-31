import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ComponentProps, JSX, ReactNode } from 'react'

import { Checkbox } from './checkbox.tsx'
import styles from './field-checklist.module.css'

type FieldChecklistFieldBase<TId extends string> = {
  /** Stable id handed back to {@link FieldChecklistProps.onToggle}. */
  readonly id: TId
  /** The field's name, set in mono (`birthDate`). */
  readonly name: string
  /**
   * The value the field holds now. Any empty node (`null`, `undefined`, a
   * boolean or `''`) reads as an empty field.
   */
  readonly from: ReactNode
  /** The value taking the field sets. */
  readonly to: ReactNode
  /**
   * Taking the field only adds to what is there (it is empty, or `to` extends
   * `from`) rather than overwriting it, so `to` is painted in the success tone.
   */
  readonly fillsGap: boolean
}

/** Whether a node renders nothing, as `from` does for an empty field. */
const isEmptyNode = (node: ReactNode): boolean =>
  node === null || node === undefined || typeof node === 'boolean' || node === ''

/**
 * One field in a {@link FieldChecklist}: either the reader's to tick, or always
 * taken, its box checked and disabled with the reason after its value.
 */
type FieldChecklistField<TId extends string> = FieldChecklistFieldBase<TId> &
  (
    | { readonly checked: boolean; readonly alwaysTakenReason?: never }
    | { readonly alwaysTakenReason: string; readonly checked?: never }
  )

/**
 * Props for {@link FieldChecklist}: the parent label, the fields, their
 * handlers, and any other `<div>` prop, which go to the root.
 */
interface FieldChecklistProps<TId extends string> extends Omit<
  ComponentProps<'div'>,
  'children' | 'onToggle'
> {
  /** The parent checkbox's label ("Update with import details · 1 of 2"). */
  readonly label: ReactNode
  readonly fields: readonly FieldChecklistField<TId>[]
  readonly onToggle: (id: TId, checked: boolean) => void
  /**
   * Called by the parent checkbox with the state for every field the reader
   * can tick: `true` unless all of them already are.
   */
  readonly onToggleAll: (checked: boolean) => void
}

/**
 * A parent checkbox over one checkbox per field, each showing the change as
 * `name from → to` (`name gains to` when the field is empty). The parent is
 * checked, partly checked or empty by the fields under it, and ticks or
 * clears them all. With no field to tick it is disabled: checked when every
 * field is always taken, empty when there are no fields.
 */
const FieldChecklist = <TId extends string>({
  label,
  fields,
  onToggle,
  onToggleAll,
  className,
  ...rootProps
}: FieldChecklistProps<TId>): JSX.Element => {
  const tickable = fields.filter((field) => field.alwaysTakenReason === undefined)
  const tickedCount = tickable.filter((field) => field.checked).length
  const allTicked = tickable.length > 0 && tickedCount === tickable.length
  const parentLabel = <span className={styles['field-checklist__label']}>{label}</span>
  return (
    <div {...rootProps} className={cn(styles['field-checklist'], className)}>
      {tickable.length > 0 ? (
        <Checkbox
          checked={allTicked}
          indeterminate={tickedCount > 0 && !allTicked}
          onChange={() => {
            onToggleAll(!allTicked)
          }}
          label={parentLabel}
        />
      ) : (
        <Checkbox checked={fields.length > 0} disabled={true} label={parentLabel} />
      )}
      {fields.map((field) => {
        const taken = field.alwaysTakenReason !== undefined || field.checked
        const change = (
          <span
            className={cn(
              styles['field-checklist__change'],
              taken ? null : styles['field-checklist__change--left']
            )}
          >
            <span className={styles['field-checklist__name']}>{field.name}</span>{' '}
            {isEmptyNode(field.from) ? 'gains' : <>{field.from} →</>}{' '}
            <span
              className={cn(
                styles['field-checklist__to'],
                field.fillsGap ? styles['field-checklist__to--fills-gap'] : null
              )}
            >
              {field.to}
            </span>
            {field.alwaysTakenReason === undefined ? null : (
              <span className={styles['field-checklist__reason']}>
                {' '}
                · {field.alwaysTakenReason}
              </span>
            )}
          </span>
        )
        return field.alwaysTakenReason === undefined ? (
          <Checkbox
            key={field.id}
            className={styles['field-checklist__field']}
            checked={field.checked}
            onChange={(checked) => {
              onToggle(field.id, checked)
            }}
            label={change}
          />
        ) : (
          <Checkbox
            key={field.id}
            className={styles['field-checklist__field']}
            checked={true}
            disabled={true}
            label={change}
          />
        )
      })}
    </div>
  )
}

export { FieldChecklist, type FieldChecklistField, type FieldChecklistProps }
