import { Either, ParseResult, Schema } from 'effect'
import { defaultConfig, InstanceConfig } from 'fhir-r4-client-collector'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles } from 'react-tundraish'

import type { ConfigFormProps } from './config-form.tsx'
import fields from './account-form.module.css'

/** The decoded FHIR R4 per-instance config (`{ _tag, rootUrl, patientId }`). */
type FhirConfig = typeof InstanceConfig.Type

/**
 * The FHIR R4 config fields (`rootUrl` / `patientId`) as a
 * {@link ConfigFormProps} form. Registered against the `fhir-r4` tag in
 * {@link file://./config-form.tsx}; the generic account screens supply the
 * shared name field / type badge (`header`) and the Save/Cancel row (`footer`)
 * around it.
 *
 * The seed order is `initial` (an existing remote's stored config, on the edit
 * screen) → `prefill` (the loose `Record<string,string>` handed off via the
 * `/collector/account/new` search) → {@link defaultConfig}, so a fresh form
 * still comes up populated with the demo server exactly as it did before this
 * ticket.
 *
 * Validation is submit-time: on Save the fields are decoded through
 * {@link InstanceConfig} (the same `rootUrl`/`patientId` patterns the wire
 * enforces); a `ParseError` renders inline and blocks the mutation rather than
 * round-tripping bad input to the server.
 */
function FhirR4ConfigForm({
  initial,
  prefill,
  disabled,
  onSubmit,
  header,
  footer,
}: ConfigFormProps<FhirConfig>): JSX.Element {
  const [rootUrl, setRootUrl] = useState(
    initial?.rootUrl ?? prefill?.['rootUrl'] ?? defaultConfig.rootUrl
  )
  const [patientId, setPatientId] = useState(
    initial?.patientId ?? prefill?.['patientId'] ?? defaultConfig.patientId
  )
  const [fieldError, setFieldError] = useState<string | null>(null)

  const submit = (): void => {
    const decoded = Schema.decodeUnknownEither(InstanceConfig)({
      _tag: 'fhir-r4',
      rootUrl,
      patientId,
    })
    if (Either.isLeft(decoded)) {
      setFieldError(ParseResult.TreeFormatter.formatErrorSync(decoded.left))
      return
    }
    setFieldError(null)
    onSubmit(decoded.right)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {header}

      {fieldError !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{fieldError}</p>
      ) : null}

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-rootUrl">
          Root URL
        </label>
        <input
          id="cl-rootUrl"
          className="input-2"
          value={rootUrl}
          disabled={disabled}
          onChange={(e) => {
            setRootUrl(e.target.value)
          }}
          placeholder="Root URL"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-patientId">
          Patient ID
        </label>
        <input
          id="cl-patientId"
          className="input-2"
          value={patientId}
          disabled={disabled}
          onChange={(e) => {
            setPatientId(e.target.value)
          }}
          placeholder="Patient ID"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      {footer}
    </form>
  )
}

export { FhirR4ConfigForm }
export type { FhirConfig }
