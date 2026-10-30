import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ChangeEvent, JSX, ReactNode } from 'react'

type CheckboxBase = {
  readonly checked: boolean
  /**
   * Paint the box as partly checked (a dash) — a parent over some, not all,
   * of its children. It is a display state only: a click still reports the
   * next `checked`.
   */
  readonly indeterminate?: boolean
  readonly label: ReactNode
  readonly className?: string
}

type CheckboxProps = CheckboxBase &
  (
    | { readonly disabled: true; readonly onChange?: (checked: boolean) => void }
    | { readonly disabled?: false; readonly onChange: (checked: boolean) => void }
  )

const Checkbox = (props: CheckboxProps): JSX.Element => {
  const { checked, indeterminate = false, label, disabled, className } = props
  return (
    <label className={cn('checkbox-row', className)}>
      <input
        // `indeterminate` is a DOM property with no attribute, so React can
        // only set it through the element.
        ref={(input) => {
          if (input !== null) input.indeterminate = indeterminate
        }}
        type="checkbox"
        className="checkbox-2"
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          props.onChange?.(event.target.checked)
        }}
      />
      <span className="text-body-2">{label}</span>
    </label>
  )
}

export { Checkbox, type CheckboxProps }
