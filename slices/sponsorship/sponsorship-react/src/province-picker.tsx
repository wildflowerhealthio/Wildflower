import type { JSX } from 'react'

import { isProvince, type Province, provinceCodes, provinceNames } from 'sponsorship-core'

import styles from './province-picker.module.css'

interface ProvincePickerProps {
  readonly value: Province
  readonly onChange: (province: Province) => void
  readonly id?: string
}

/**
 * A labelled `<select>` of the thirteen provinces / territories. The change
 * handler is guarded by `isProvince` so the callback always receives a valid
 * `Province` with no cast (the options only ever hold valid codes).
 */
export const ProvincePicker = ({ value, onChange, id }: ProvincePickerProps): JSX.Element => (
  <label className={styles.picker}>
    <span className={styles.label}>Province</span>
    <select
      className={styles.select}
      id={id}
      value={value}
      onChange={(event) => {
        const next = event.currentTarget.value
        if (isProvince(next)) onChange(next)
      }}
    >
      {provinceCodes.map((code) => (
        <option key={code} value={code}>
          {provinceNames[code]}
        </option>
      ))}
    </select>
  </label>
)

export type { ProvincePickerProps }
