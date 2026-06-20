import { useId, type ChangeEvent, type JSX, type ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import { Field, FieldDescription } from './field.tsx'
import styles from './text-field.module.css'

type TextFieldType = 'text' | 'password' | 'email' | 'url' | 'tel' | 'search'

type TextFieldInputMode =
  | 'text'
  | 'numeric'
  | 'decimal'
  | 'email'
  | 'url'
  | 'search'
  | 'tel'
  | 'none'

interface TextFieldProps {
  /** Label rendered above the input as the Field eyebrow. */
  readonly label: ReactNode
  /** Controlled value of the input. */
  readonly value: string
  /** Called with the new string whenever the user edits the input. */
  readonly onChange: (next: string) => void
  /**
   * DOM id for the underlying `<input>`. Auto-generated via `useId`
   * when omitted; supply explicitly only if an outside caller needs to
   * reference the same id (e.g. to focus it programmatically).
   */
  readonly id?: string
  /** HTML input type. Defaults to `text`. */
  readonly type?: TextFieldType
  /** Mobile virtual-keyboard hint forwarded to the `<input>`. */
  readonly inputMode?: TextFieldInputMode
  readonly placeholder?: string
  readonly autoComplete?: string
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
  readonly disabled?: boolean
  /** Secondary helper rendered beneath the input via `<FieldDescription>`. */
  readonly description?: ReactNode
  /**
   * Accent the field's border to mark it as the input the user would
   * actively change in this context (e.g. a write-only token sitting
   * among rarely-touched coordinates). Defaults to `false`.
   */
  readonly callout?: boolean
  readonly className?: string
}

/**
 * Single-line text input bundled with its eyebrow label and optional
 * helper line. Composes the existing `<Field>` + `<FieldDescription>`
 * primitives over tundra-css's `input-2` so every form input on the
 * surface stays one shape — and a future input-size or label-style
 * change re-points all consumers through this one component.
 *
 * The control is fully controlled (`value` + `onChange`); the
 * generic, app-agnostic shape (no form-library coupling) keeps the
 * primitive immediately reusable across slices.
 */
const TextField = ({
  label,
  value,
  onChange,
  id,
  type = 'text',
  inputMode,
  placeholder,
  autoComplete = 'off',
  autoCapitalize = 'none',
  disabled,
  description,
  callout = false,
  className,
}: TextFieldProps): JSX.Element => {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <Field label={label} htmlFor={inputId}>
      <input
        id={inputId}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        className={cn('input-2', callout ? styles['text-field__input--callout'] : null, className)}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.value)
        }}
      />
      {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}

export { TextField }
export type { TextFieldProps }
