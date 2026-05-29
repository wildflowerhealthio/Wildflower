/* oxlint-disable react/only-export-components -- file-based route file exports `Route` alongside the component */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import pageLayout from '../../../styles/page-layout.module.css'
import styles from './devices.module.css'

const DEVICE_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/

const normalize = (raw: string): string => {
  const upper = raw.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ-]/g, '')
  const stripped = upper.replace(/-/g, '')
  if (stripped.length <= 4) return stripped
  return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`
}

function DeviceEntryScreen(): JSX.Element {
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  const isValid = DEVICE_CODE_PATTERN.test(code)

  const submit = (): void => {
    if (!isValid) return
    void navigate({ to: `/gatekeeper/devices/${encodeURIComponent(code)}` })
  }

  return (
    <div className={pageLayoutStyles['page']}>
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

export const Route = createFileRoute('/gatekeeper/devices')({
  component: DeviceEntryScreen,
})
