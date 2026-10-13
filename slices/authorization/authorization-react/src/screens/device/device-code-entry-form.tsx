import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Field, FieldDescription } from '@wildflowerhealthio/react-tundraish'
import { useId, useState, type JSX } from 'react'

import { DEVICE_CODE_PATTERN, normalize } from './device-code.ts'
import deviceCode from '../../styles/device-code.module.css'
import pageLayout from '../../styles/page-layout.module.css'

type DeviceCodeEntryFormProps = {
  /**
   * Called with a validated `XXXX-XXXX` code when the owner submits. The
   * caller navigates to its device-consent route,
   * `/authorization/devices/$userCode`.
   */
  readonly onSubmit: (code: string) => void
}

/**
 * The device-code entry form of the public `/authorization/devices` route.
 * Renders no header itself — the route supplies its own `<PageHeader>`.
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
          className={cn('input-2', deviceCode['pin-input'])}
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
