import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

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
  readonly legend?: string
  /**
   * The radios' and their labels' size, tundra's `radio-N` and
   * `text-body-N`; 2 by default.
   */
  readonly size?: 2 | 3 | 4
  readonly className?: string
}

const RadioGroup = <T extends string>({
  name,
  value,
  onChange,
  options,
  legend,
  size = 2,
  className,
}: RadioGroupProps<T>): JSX.Element => (
  <fieldset className={cn('radio-group', className)}>
    {legend !== undefined ? <legend className="text-label-2">{legend}</legend> : null}
    {options.map((option) => (
      <label key={option.value} className="radio-row">
        <input
          type="radio"
          className={`radio-${String(size)}`}
          name={name}
          value={option.value}
          checked={option.value === value}
          disabled={option.disabled}
          onChange={() => onChange(option.value)}
        />
        <span className={`text-body-${String(size)}`}>{option.label}</span>
      </label>
    ))}
  </fieldset>
)

export { RadioGroup, type RadioGroupProps, type RadioOption }
