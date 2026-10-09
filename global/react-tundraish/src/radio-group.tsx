import { type JSX, type ReactNode, useId } from 'react'
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
  readonly className?: string
}

/**
 * A `radiogroup` of `radio-3` rows, each a `label-3` label around its
 * input, named by `legend` when given.
 *
 * @remarks
 * The group is a `div` named through `aria-labelledby` rather than a
 * `<fieldset>` and `<legend>`: Firefox doesn't lay a `<fieldset>` out as a
 * flex container, so its rows wouldn't stack with their gap.
 */
const RadioGroup = <T extends string>({
  name,
  value,
  onChange,
  options,
  legend,
  className,
}: RadioGroupProps<T>): JSX.Element => {
  const legendId = useId()
  return (
    <div
      role="radiogroup"
      aria-labelledby={legend === undefined ? undefined : legendId}
      className={cn('radio-group', className)}
    >
      {legend === undefined ? null : (
        <span id={legendId} className="text-label-3">
          {legend}
        </span>
      )}
      {options.map((option) => (
        <label key={option.value} className="label-3 radio-row">
          <input
            type="radio"
            className="radio-3"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}

export { RadioGroup, type RadioGroupProps, type RadioOption }
