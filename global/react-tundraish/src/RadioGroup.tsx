import type { ChangeEvent, JSX, ReactNode } from 'react'

type RadioOption<T extends string> = {
  readonly value: T
  readonly label: ReactNode
  readonly disabled?: boolean
}

type RadioGroupProps<T extends string> = {
  readonly name: string
  readonly value: T
  readonly onChange: (value: T) => void
  readonly options: readonly RadioOption<T>[]
  readonly legend?: ReactNode
  readonly className?: string
}

const RadioGroup = <T extends string>({
  name,
  value,
  onChange,
  options,
  legend,
  className,
}: RadioGroupProps<T>): JSX.Element => {
  const classes = ['radio-group', className].filter((c) => c !== undefined).join(' ')
  return (
    <fieldset className={classes}>
      {legend !== undefined ? <legend className="text-label-2">{legend}</legend> : null}
      {options.map((option) => (
        <label key={option.value} className="radio-row">
          <input
            type="radio"
            className="radio-2"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              if (event.target.checked) {
                onChange(option.value)
              }
            }}
          />
          <span className="text-body-2">{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export { RadioGroup, type RadioGroupProps, type RadioOption }
