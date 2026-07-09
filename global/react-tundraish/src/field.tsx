import { useId, type JSX, type PropsWithChildren, type ReactNode } from 'react'

import styles from './field.module.css'

type FieldProps = PropsWithChildren<{
  /** Sentence-case label rendered above the field's content. */
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
 * explanatory text. The label is typeset as the design's small sentence-case
 * sans label (weight 500, defined entirely in `.field__label`, not a tundra-css
 * text token) and the description as sans, muted helper text.
 *
 * Pass `htmlFor` (the control's `id`) when the field wraps a single input
 * so the label is programmatically associated with it.
 */
const Field = ({ label, htmlFor, children }: FieldProps): JSX.Element => (
  <div className={styles['field']}>
    {htmlFor === undefined ? (
      <span className={styles['field__label']}>{label}</span>
    ) : (
      <label htmlFor={htmlFor} className={styles['field__label']}>
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
      <span id={labelId} className={styles['field__label']}>
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
 * Secondary text inside a `<Field>`. Typeset a notch smaller than body
 * (sans, ~12px) so the helper sits beneath its label/input without
 * competing for primary-copy weight; muted with the fainter neutral
 * tint (a step below the crisp label). Typesetting lives in
 * `.field__description` — see the module CSS for the size/weight rationale.
 */
const FieldDescription = ({ children }: FieldDescriptionProps): JSX.Element => (
  <span className={styles['field__description']}>{children}</span>
)

export { Field, FieldDescription, FieldGroup }
export type { FieldProps, FieldDescriptionProps, FieldGroupProps }
