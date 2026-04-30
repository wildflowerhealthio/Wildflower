import { cn } from 'kitchen-sink'
import type { ChangeEvent, JSX, ReactNode } from 'react'

type CheckboxBase = {
  readonly checked: boolean
  readonly label: ReactNode
  readonly className?: string
}

type CheckboxProps = CheckboxBase &
  (
    | { readonly disabled: true; readonly onChange?: (checked: boolean) => void }
    | { readonly disabled?: false; readonly onChange: (checked: boolean) => void }
  )

const Checkbox = (props: CheckboxProps): JSX.Element => {
  const { checked, label, disabled, className } = props
  return (
    <label className={cn('checkbox-row', className)}>
      <input
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
