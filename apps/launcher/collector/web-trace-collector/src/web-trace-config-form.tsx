import type { ConfigFormProps } from 'collector-fundamentals/config-form'
import { Either, ParseResult, Schema } from 'effect'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles } from 'react-tundraish'

import { defaultConfig, InstanceConfig } from './config.ts'
import fields from './web-trace-config-form.module.css'

/** The decoded web-trace per-instance config. */
type WebTraceConfig = typeof InstanceConfig.Type

/** Render `bodyContentTypes` for the text input, and read it back. */
const joinContentTypes = (types: readonly string[]): string => types.join(', ')
const splitContentTypes = (value: string): readonly string[] =>
  value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')

/**
 * The web-trace config fields as a {@link ConfigFormProps} form.
 * `collector-react` registers it against the `web-trace` tag in its
 * `tag → form` registry. Fields seed `initial` → `prefill` →
 * {@link defaultConfig}, and Save decodes them through {@link InstanceConfig},
 * rendering any `ParseError` inline instead of round-tripping bad input to the
 * server. Mirrors `RexallConfigForm`.
 *
 * `maxBodyBytes` is edited in KiB because bytes are unreadable at this scale;
 * the config stores bytes. The content-type field is a comma-separated list of
 * media-type *tokens* (`json`, not `application/json`) — the hint text says so,
 * since a full media type would silently match nothing.
 */
function WebTraceConfigForm({
  initial,
  prefill,
  disabled,
  onSubmit,
  header,
  footer,
}: ConfigFormProps<WebTraceConfig>): JSX.Element {
  const [rootUrl, setRootUrl] = useState(
    initial?.rootUrl ?? prefill?.['rootUrl'] ?? defaultConfig.rootUrl
  )
  const [sessionLabel, setSessionLabel] = useState(
    initial?.sessionLabel ?? prefill?.['sessionLabel'] ?? ''
  )
  const [bodyContentTypes, setBodyContentTypes] = useState(
    joinContentTypes(initial?.bodyContentTypes ?? defaultConfig.bodyContentTypes)
  )
  const [maxBodyKib, setMaxBodyKib] = useState(
    String(Math.round((initial?.maxBodyBytes ?? defaultConfig.maxBodyBytes) / 1024))
  )
  const [fieldError, setFieldError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmedLabel = sessionLabel.trim()
    const decoded = Schema.decodeUnknownEither(InstanceConfig)({
      _tag: 'web-trace',
      rootUrl,
      // An empty label is *absent*, not an empty string — the field is optional
      // and `listSubtitle` reads it to decide whether to show a suffix.
      ...(trimmedLabel === '' ? {} : { sessionLabel: trimmedLabel }),
      bodyContentTypes: splitContentTypes(bodyContentTypes),
      // `Number('')` is 0 and `Number('abc')` is NaN; both are rejected by
      // `MaxBodyBytesSchema` rather than silently becoming a cap.
      maxBodyBytes: Number(maxBodyKib) * 1024,
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
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-root-url">
          Start URL
        </label>
        <input
          id="cl-root-url"
          className="input-2"
          type="url"
          value={rootUrl}
          disabled={disabled}
          onChange={(e) => {
            setRootUrl(e.target.value)
          }}
          placeholder="https://portal.example.com"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-session-label">
          Session label (optional)
        </label>
        <input
          id="cl-session-label"
          className="input-2"
          type="text"
          value={sessionLabel}
          disabled={disabled}
          onChange={(e) => {
            setSessionLabel(e.target.value)
          }}
          placeholder="Prescriptions refill flow"
        />
      </div>

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-body-types">
          Store bodies for
        </label>
        <input
          id="cl-body-types"
          className="input-2"
          type="text"
          value={bodyContentTypes}
          disabled={disabled}
          onChange={(e) => {
            setBodyContentTypes(e.target.value)
          }}
          placeholder="json, text, html, xml"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <p className={cn(fields['field__hint'], 'text-body-3')}>
          Comma-separated media-type tokens, e.g. <code>json</code> or <code>fhir+json</code> — not
          full types like <code>application/json</code>. Every request is recorded either way; this
          only decides whose body is kept.
        </p>
      </div>

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-max-body">
          Maximum body size (KiB)
        </label>
        <input
          id="cl-max-body"
          className="input-2"
          type="number"
          min={0}
          value={maxBodyKib}
          disabled={disabled}
          onChange={(e) => {
            setMaxBodyKib(e.target.value)
          }}
          placeholder="1024"
        />
        <p className={cn(fields['field__hint'], 'text-body-3')}>
          A larger body is still recorded, with its size and hash but no content.
        </p>
      </div>

      {footer}
    </form>
  )
}

export { WebTraceConfigForm }
export type { WebTraceConfig }
