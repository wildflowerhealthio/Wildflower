import { useState, type JSX } from 'react'
import { useNavigate } from 'react-router'

import { Field, FieldDescription } from '../components/Field.tsx'
import pageLayout from '../styles/page-layout.module.css'
import styles from './device-entry.module.css'

const DEVICE_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/

const normalize = (raw: string): string => {
  const upper = raw.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ-]/g, '')
  const stripped = upper.replace(/-/g, '')
  if (stripped.length <= 4) return stripped
  return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`
}

const DeviceEntryScreen = (): JSX.Element => {
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  const isValid = DEVICE_CODE_PATTERN.test(code)

  const submit = (): void => {
    if (!isValid) return
    void navigate(`/devices/${encodeURIComponent(code)}`)
  }

  return (
    <div className={pageLayout['page']}>
      <h1 className="text-heading-4">Enter Device Code</h1>
      <FieldDescription>Enter the code shown on the device requesting access.</FieldDescription>

      <Field label="Code">
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          className={styles['pin-input']}
          value={code}
          onChange={(e) => {
            setCode(normalize(e.target.value))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="BCDF-GHJK"
          maxLength={9}
          autoFocus
        />
      </Field>

      <div className={pageLayout['buttons']}>
        <button type="button" className="button-2 filled" disabled={!isValid} onClick={submit}>
          Continue
        </button>
      </div>
    </div>
  )
}

export { DeviceEntryScreen }
