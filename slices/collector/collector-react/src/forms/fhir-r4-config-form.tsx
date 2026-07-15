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
 * {@link ConfigFormProps} form, registered against the `fhir-r4` tag in
 * {@link file://./config-form.tsx}. Fields seed `initial → prefill →
 * {@link defaultConfig}` (so a fresh form still comes up on the demo server),
 * and Save decodes them through {@link InstanceConfig}, rendering any
 * `ParseError` inline instead of round-tripping bad input to the server.
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
