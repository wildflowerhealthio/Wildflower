import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ChangeEvent, JSX, ReactNode } from 'react'

import styles from './toggle-switch.module.css'

type ToggleSwitchBase = {
  readonly checked: boolean
  /**
   * Visible label rendered beside the switch. Clicks anywhere on the row
   * (label or track) flip the control, since both live inside the same
   * `<label>` element.
   */
  readonly label: ReactNode
  /**
   * The id of an element that says more about the switch (what turning it
   * on does), set as the input's `aria-describedby` so assistive tech reads
   * it after the label.
   */
  readonly describedBy?: string
  readonly className?: string
}

/**
 * Mirrors `Checkbox`'s disabled-vs-onChange split: a `disabled` switch
 * may omit `onChange` entirely (read-only display); a non-disabled
 * switch must supply one. The discriminated union enforces this at the
 * call site rather than relying on a runtime null-check.
 */
type ToggleSwitchProps = ToggleSwitchBase &
  (
    | { readonly disabled: true; readonly onChange?: (checked: boolean) => void }
    | { readonly disabled?: false; readonly onChange: (checked: boolean) => void }
  )

/**
 * Pill-style switch primitive — a sliding knob inside a colored track.
 *
 * Implemented on a native `<input type="checkbox" role="switch">` so the
 * control inherits browser keyboard handling (Tab + Space), form
 * participation, and assistive-technology semantics ("switch", on/off)
 * without manual ARIA. The input is visually hidden but laid behind the
 * painted track at its exact footprint, so pointer / focus events land
 * on the visible control; the track and knob are painted in CSS and
 * mirror the input's `:checked` / `:disabled` / `:focus-visible` state
 * via sibling selectors.
 *
 * Generic on purpose — it carries no app-specific knowledge. Use it
 * anywhere a binary, instantly-applied on/off control is wanted. For
 * Save-on-submit forms a `Checkbox` reads more naturally; reserve the
 * switch for "this takes effect now" toggles.
 */
const ToggleSwitch = (props: ToggleSwitchProps): JSX.Element => {
  const { checked, label, describedBy, disabled, className } = props
  return (
    <label className={cn(styles['toggle-switch-row'], className)}>
      <span className={styles['toggle-switch']}>
        <input
          type="checkbox"
          role="switch"
          className={styles['toggle-switch__input']}
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            props.onChange?.(event.target.checked)
          }}
        />
        <span className={styles['toggle-switch__track']} aria-hidden="true" />
      </span>
      <span className={styles['toggle-switch__label']}>{label}</span>
    </label>
  )
}

export { ToggleSwitch, type ToggleSwitchProps }
