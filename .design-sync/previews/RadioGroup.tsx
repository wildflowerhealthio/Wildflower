import { useState } from 'react'
import { RadioGroup } from 'react-tundraish'

/**
 * A named group via `legend` — the canonical use. The native `<fieldset>` the
 * group renders is named by the legend, so no outer Field/FieldGroup wrapper is
 * needed (gatekeeper oauth-consent patient picker).
 */
export const PatientContext = () => {
  const [value, setValue] = useState('')
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup
        legend="Patient Context"
        name="patient"
        value={value}
        onChange={setValue}
        options={[
          { value: '', label: 'No patient context' },
          { value: 'pat-1', label: 'Ada Lovelace' },
          { value: 'pat-2', label: 'Grace Hopper' },
        ]}
      />
    </div>
  )
}

/** A short single-select with one disabled option. */
export const WithDisabledOption = () => {
  const [value, setValue] = useState('monthly')
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup
        legend="Billing cycle"
        name="billing"
        value={value}
        onChange={setValue}
        options={[
          { value: 'monthly', label: 'Monthly' },
          { value: 'annual', label: 'Annual (save 20%)' },
          { value: 'lifetime', label: 'Lifetime (not available on your plan)', disabled: true },
        ]}
      />
    </div>
  )
}
