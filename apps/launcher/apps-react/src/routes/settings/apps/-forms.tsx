import type { JSX } from 'react'
import { FieldDescription, TextField, ToggleSwitch } from 'react-tundraish'

import type { AppBody } from '../../../queries.ts'
import formStyles from './-forms.module.css'

/**
 * Shared form pieces for the apps settings pages. The `-` prefix keeps this
 * module out of the route tree the TanStack plugin generates from this
 * directory (the `index.tsx` / `new.tsx` / `$id.tsx` files are the real routes).
 */

/** Controlled state for an app's editable fields, shared by create + edit. */
interface AppFields {
  readonly name: string
  readonly subtitle: string
  readonly url: string
  readonly requiresTunnel: boolean
}

interface AppFieldInputsProps {
  readonly fields: AppFields
  readonly onChange: (fields: AppFields) => void
  readonly disabled?: boolean
}

/**
 * The four controlled inputs an app carries (name / subtitle / launch URL /
 * requires-tunnel), used by both the create page and the per-app edit page. The
 * URL description spells out the `{origin}` / `{launch}` tokens the server
 * substitutes at launch (matching `apps-core-js/http-api-definition`'s
 * `Schemas.AppUrlSchema`).
 */
const AppFieldInputs = ({ fields, onChange, disabled }: AppFieldInputsProps): JSX.Element => (
  <>
    <TextField
      label="Name"
      value={fields.name}
      disabled={disabled}
      onChange={(name) => {
        onChange({ ...fields, name })
      }}
    />
    <TextField
      label="Subtitle"
      value={fields.subtitle}
      description="Optional — shown under the app name. Leave empty to clear it."
      disabled={disabled}
      onChange={(subtitle) => {
        onChange({ ...fields, subtitle })
      }}
    />
    <TextField
      label="URL"
      inputMode="url"
      value={fields.url}
      placeholder="https://example.com/launch"
      description="Supports the {origin} and {launch} tokens, resolved at launch."
      disabled={disabled}
      onChange={(url) => {
        onChange({ ...fields, url })
      }}
    />
    <div className={formStyles['toggle-field']}>
      {disabled === true ? (
        <ToggleSwitch checked={fields.requiresTunnel} label="Requires Tunnel" disabled />
      ) : (
        <ToggleSwitch
          checked={fields.requiresTunnel}
          label="Requires Tunnel"
          onChange={(requiresTunnel) => {
            onChange({ ...fields, requiresTunnel })
          }}
        />
      )}
      <FieldDescription>
        Shows a Tunnel pill on the app’s tile. It has no effect on launch: every app launches at
        your server’s public address.
      </FieldDescription>
    </div>
  </>
)

/**
 * The JSON body the fields submit to `POST /apps` / `PUT /apps/:id`, or
 * `undefined` while a required field (name, URL) is blank. Every field is
 * trimmed, and an empty subtitle is omitted so the server stores "no subtitle".
 */
const appBodyFrom = (fields: AppFields): AppBody | undefined => {
  const name = fields.name.trim()
  const url = fields.url.trim()
  if (name === '' || url === '') return undefined
  const subtitle = fields.subtitle.trim()
  return {
    name,
    url,
    requiresTunnel: fields.requiresTunnel,
    ...(subtitle === '' ? {} : { subtitle }),
  }
}

export { AppFieldInputs, appBodyFrom }
export type { AppFields }
