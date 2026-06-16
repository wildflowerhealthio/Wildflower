import { useId, type JSX, type PropsWithChildren, type ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './field.module.css'

type FieldProps = PropsWithChildren<{
  /** Label rendered above the field's content. Always typeset as `text-label-3`. */
  readonly label: ReactNode
  /**
   * The `id` of the single form control this field labels. When set, the
   * label renders as a real `<label htmlFor>` so assistive tech announces
   * it and clicking the label focuses the control. Omit for a read-only
   * value (the label renders as a plain `<span>`); for a *group* of
   * controls (checkboxes, radios) use {@link FieldGroup} instead — a
   * `<label>` can only bind to one control.
   */
  readonly htmlFor?: string
}>

/**
 * Vertical label/value stack. Pair with `<FieldDescription>` for secondary
 * explanatory text. The label is typeset as `text-label-3` and the optional
 * description as `text-body-3`, both tinted with the muted neutral color.
 *
 * Pass `htmlFor` (the control's `id`) when the field wraps a single input
 * so the label is programmatically associated with it.
 */
const Field = ({ label, htmlFor, children }: FieldProps): JSX.Element => (
  <div className={styles['field']}>
    {htmlFor === undefined ? (
      <span className={cn(styles['field__label'], 'text-label-3')}>{label}</span>
    ) : (
      <label htmlFor={htmlFor} className={cn(styles['field__label'], 'text-label-3')}>
        {label}
      </label>
    )}
    {children}
  </div>
)

type FieldGroupProps = PropsWithChildren<{
  /** Group label rendered above the controls. Names the group for assistive tech. */
  readonly label: ReactNode
}>

/**
 * Like {@link Field} but for a *group* of related controls (a set of
 * checkboxes or radios) rather than a single input. A `<label>` can only
 * bind to one control, so the group is exposed as `role="group"` named via
 * `aria-labelledby` — assistive tech announces the group label, and each
 * control keeps its own per-option label. Visually identical to `Field`.
 */
const FieldGroup = ({ label, children }: FieldGroupProps): JSX.Element => {
  const labelId = useId()
  return (
    <div className={styles['field']} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={cn(styles['field__label'], 'text-label-3')}>
        {label}
      </span>
      {children}
    </div>
  )
}

interface FieldDescriptionProps {
  readonly children: ReactNode
}

/**
 * Secondary text inside a `<Field>`. Typeset as `text-body-3` and tinted
 * with the field's muted color.
 */
const FieldDescription = ({ children }: FieldDescriptionProps): JSX.Element => (
  <span className={cn(styles['field__description'], 'text-body-3')}>{children}</span>
)

export { Field, FieldDescription, FieldGroup }
export type { FieldProps, FieldDescriptionProps, FieldGroupProps }
