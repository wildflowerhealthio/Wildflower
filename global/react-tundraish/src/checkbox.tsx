import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { useEffect, useRef, type ChangeEvent, type JSX, type ReactNode } from 'react'

type CheckboxBase = {
  readonly checked: boolean
  /**
   * Paint the box as partly checked (a dash) — a parent over some, not all,
   * of its children. It is a display state only: a click still reports the
   * next `checked`.
   */
  readonly indeterminate?: boolean
  readonly label: ReactNode
  /** The input's accessible name, when it should differ from the visible label. */
  readonly 'aria-label'?: string
  readonly className?: string
}

type CheckboxProps = CheckboxBase &
  (
    | { readonly disabled: true; readonly onChange?: (checked: boolean) => void }
    | { readonly disabled?: false; readonly onChange: (checked: boolean) => void }
  )

const Checkbox = (props: CheckboxProps): JSX.Element => {
  const { checked, indeterminate = false, label, disabled, className } = props
  // `indeterminate` is a DOM property with no attribute, so React can only
  // set it through the element.
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (input.current !== null) input.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className={cn('checkbox-row', className)}>
      <input
        ref={input}
        type="checkbox"
        className="checkbox-2"
        checked={checked}
        disabled={disabled}
        aria-label={props['aria-label']}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          props.onChange?.(event.target.checked)
          // A click clears `indeterminate`; put the prop back, as React does
          // for `checked`, in case the parent keeps the mixed state.
          event.target.indeterminate = indeterminate
        }}
      />
      <span className="text-body-2">{label}</span>
    </label>
  )
}

export { Checkbox, type CheckboxProps }
