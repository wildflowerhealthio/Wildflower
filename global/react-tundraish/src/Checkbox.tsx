import type { ChangeEvent, JSX, ReactNode } from 'react'

type CheckboxProps = {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly className?: string
}

const Checkbox = ({
  checked,
  onChange,
  label,
  disabled,
  className,
}: CheckboxProps): JSX.Element => {
  const classes = ['checkbox-row', className].filter((c) => c !== undefined).join(' ')
  return (
    <label className={classes}>
      <input
        type="checkbox"
        className="checkbox-2"
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.checked)
        }}
      />
      <span className="text-body-2">{label}</span>
    </label>
  )
}

export { Checkbox, type CheckboxProps }
