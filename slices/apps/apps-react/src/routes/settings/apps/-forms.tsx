import { useState, type JSX } from 'react'
import { ErrorBanner, FieldDescription, TextField, ToggleSwitch } from 'react-tundraish'

import { useAppReplaceMutation, type AppRegistration } from '../../../queries.ts'
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
 * substitutes at launch (matching `apps-core/http-api-definition`'s
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
        Some apps need to reach your health data over the internet to work. This setting ensures the
        tunnel is running when the app launches.
      </FieldDescription>
    </div>
  </>
)

/**
 * Full-replace editor for an app's content — name / subtitle / launch URL /
 * requires-tunnel, prefilled from the {@link AppRegistration}. Saving `PUT`s the
 * whole content to `/apps/:id` via {@link useAppReplaceMutation}; an empty
 * subtitle clears it.
 */
const AppEditForm = ({ app }: { readonly app: AppRegistration }): JSX.Element => {
  const replaceMutation = useAppReplaceMutation()
  const [fields, setFields] = useState<AppFields>({
    name: app.name,
    subtitle: app.subtitle ?? '',
    url: app.url,
    requiresTunnel: app.requiresTunnel,
  })

  const save = (): void => {
    const name = fields.name.trim()
    const url = fields.url.trim()
    if (name === '' || url === '') return
    const subtitle = fields.subtitle.trim()
    replaceMutation.mutate({
      id: app.id,
      payload: {
        name,
        url,
        requiresTunnel: fields.requiresTunnel,
        ...(subtitle === '' ? {} : { subtitle }),
      },
    })
  }

  return (
    <form
      className={formStyles['form']}
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <ErrorBanner error={replaceMutation.error} />
      <AppFieldInputs
        fields={fields}
        disabled={replaceMutation.isPending}
        onChange={(next) => {
          if (replaceMutation.error !== null) replaceMutation.reset()
          setFields(next)
        }}
      />
      <div className={formStyles['actions']}>
        <button type="submit" className="button-3 filled" disabled={replaceMutation.isPending}>
          Save
        </button>
      </div>
    </form>
  )
}

export { AppEditForm, AppFieldInputs }
export type { AppFields }
