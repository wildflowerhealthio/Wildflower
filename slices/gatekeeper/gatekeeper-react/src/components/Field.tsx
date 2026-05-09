import type { JSX, ReactNode, PropsWithChildren } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './Field.module.css'

type FieldProps = PropsWithChildren<{
  /** Label rendered above the field's content. Always typeset as `text-label-3`. */
  readonly label: ReactNode
}>

/**
 * Vertical label/value stack used across consent and detail screens.
 * Pair with `<FieldDescription>` for secondary explanatory text.
 */
const Field = ({ label, children }: FieldProps): JSX.Element => (
  <div className={styles['field']}>
    <span className={cn(styles['field__label'], 'text-label-3')}>{label}</span>
    {children}
  </div>
)

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

export { Field, FieldDescription }
export type { FieldProps, FieldDescriptionProps }
