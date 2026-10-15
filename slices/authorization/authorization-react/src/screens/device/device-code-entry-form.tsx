import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, Field, FieldDescription } from '@wildflowerhealthio/react-tundraish'
import { useId, useState, type JSX } from 'react'

import { DEVICE_CODE_PATTERN, normalize } from './device-code.ts'
import deviceCode from '../../styles/device-code.module.css'
import pageLayout from '../../styles/page-layout.module.css'

type DeviceCodeEntryFormProps = {
  /**
   * Called with a validated `XXXX-XXXX` code when the owner submits: the
   * authorization server's device page reads the request.
   */
  readonly onSubmit: (code: string) => void
  /**
   * The code the box starts with (RFC 8628 `verification_uri_complete`'s
   * `user_code`), normalized like typed input. The owner still submits it.
   */
  readonly initialCode?: string
  /** Why the last submitted code led nowhere, shown above the button. */
  readonly error?: unknown
  /** Whether the last submitted code is still being looked up. */
  readonly submitting?: boolean
}

/**
 * The device-code entry form of the authorization server's device page.
 * Renders no header itself — the surface supplies its own.
 */
const DeviceCodeEntryForm = ({
  onSubmit,
  initialCode = '',
  error = null,
  submitting = false,
}: DeviceCodeEntryFormProps): JSX.Element => {
  const codeInputDomId = useId()
  const [code, setCode] = useState(() => normalize(initialCode))

  const isValid = DEVICE_CODE_PATTERN.test(code)

  const submit = (): void => {
    if (!isValid || submitting) return
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

      <ErrorBanner error={error} />

      <div className={pageLayout['buttons']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={!isValid || submitting}
          onClick={submit}
        >
          Continue
        </button>
      </div>
    </>
  )
}

export { DeviceCodeEntryForm }
export type { DeviceCodeEntryFormProps }
