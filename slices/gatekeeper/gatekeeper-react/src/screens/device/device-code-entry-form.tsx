import { useId, useState, type JSX } from 'react'
import { Field, FieldDescription } from 'react-tundraish'

import { DEVICE_CODE_PATTERN, normalize } from './device-code.ts'
import deviceCode from '../../styles/device-code.module.css'
import pageLayout from '../../styles/page-layout.module.css'

type DeviceCodeEntryFormProps = {
  /**
   * Called with a validated `XXXX-XXXX` code when the owner submits. The
   * caller navigates to its own device-consent route — the public flow to
   * `/gatekeeper/devices/$userCode`, the in-settings flow to
   * `/settings/gatekeeper/devices/$userCode` — which is the only thing that
   * differs between the two surfaces that render this form.
   */
  readonly onSubmit: (code: string) => void
}

/**
 * The device-code entry form, lifted out of its route so the public
 * (`/gatekeeper/devices`) and owner-facing (`/settings/gatekeeper/devices`)
 * surfaces share one implementation and differ only in their page header
 * (the in-settings one carries a back link). Renders no header itself —
 * each route supplies its own `<PageHeader>`.
 */
const DeviceCodeEntryForm = ({ onSubmit }: DeviceCodeEntryFormProps): JSX.Element => {
  const codeInputDomId = useId()
  const [code, setCode] = useState('')

  const isValid = DEVICE_CODE_PATTERN.test(code)

  const submit = (): void => {
    if (!isValid) return
    onSubmit(code)
  }

  return (
    <>
      <FieldDescription>Enter the code shown on the device requesting access.</FieldDescription>

      <Field label="Code" htmlFor={codeInputDomId}>
        <input
          id={codeInputDomId}
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          className={deviceCode['pin-input']}
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
    </>
  )
}

export { DeviceCodeEntryForm }
export type { DeviceCodeEntryFormProps }
