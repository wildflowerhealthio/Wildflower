import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, TextField } from 'react-tundraish'

import { useAppsAdminReplaceMutation, type AppEntry } from '../../../queries.ts'
import formStyles from './-forms.module.css'

/**
 * Shared form pieces for the apps settings pages. The `-` prefix keeps this
 * module out of the route tree the TanStack plugin generates from this
 * directory (siblings `index.tsx` / `new.tsx` / `$id.tsx` are the real routes).
 */

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The self-hosted variant of the catalogue union — the only kind with an
 * editable launch path. */
type SelfHostedEntry = Extract<AppEntry, { provenance: 'self-hosted' }>

/** The cloud variant of the catalogue union — carries the editable content. */
type CloudEntry = Extract<AppEntry, { provenance: 'cloud' }>

/** Controlled state for the cloud app fields, shared by create + edit. */
interface CloudFields {
  readonly name: string
  readonly subtitle: string
  readonly url: string
  readonly requiresTunnel: boolean
}

interface CloudAppFieldsProps {
  readonly fields: CloudFields
  readonly onChange: (fields: CloudFields) => void
  readonly disabled?: boolean
}

/**
 * The four controlled inputs a cloud app carries (name / subtitle / launch URL /
 * requires-tunnel), used by both the create page and the per-app edit page. The
 * URL description spells out the `{origin}` / `{launch}` tokens the server
 * substitutes at launch (matching {@link import('apps-core/http-api-definition').Schemas.AppUrlSchema}).
 */
const CloudAppFields = ({ fields, onChange, disabled }: CloudAppFieldsProps): JSX.Element => (
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
    <Checkbox
      checked={fields.requiresTunnel}
      label="Requires tunnel"
      onChange={(requiresTunnel) => {
        onChange({ ...fields, requiresTunnel })
      }}
    />
  </>
)

/**
 * Full-replace editor for a cloud app's content — name / subtitle / launch URL /
 * requires-tunnel, prefilled from the stored row. Saving `PUT`s the whole
 * content via {@link useAppsAdminReplaceMutation} (`CloudAppContentSchema`); an
 * empty subtitle clears it. The `{ provenance: 'cloud', … }` object is passed as
 * an arm-shaped literal so it stays assignable to the discriminated request type
 * without a cast (see the mutation hook's narrowing comment).
 */
const CloudEditForm = ({ app }: { readonly app: CloudEntry }): JSX.Element => {
  const replaceMutation = useAppsAdminReplaceMutation()
  const [fields, setFields] = useState<CloudFields>({
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
        provenance: 'cloud',
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
      {replaceMutation.error !== null ? (
        <p className={cn(formStyles['error'], 'text-body-3')} role="alert">
          {formatError(replaceMutation.error)}
        </p>
      ) : null}
      <CloudAppFields
        fields={fields}
        disabled={replaceMutation.isPending}
        onChange={(next) => {
          if (replaceMutation.error !== null) replaceMutation.reset()
          setFields(next)
        }}
      />
      <div className={formStyles['actions']}>
        <button type="submit" className="button-2 filled" disabled={replaceMutation.isPending}>
          Save changes
        </button>
      </div>
    </form>
  )
}

/**
 * Inline launch-path editor for an uploaded self-hosted app. Prefilled from the
 * stored `launchPath` (a SMART launcher path with `{origin}` / `{launch}`
 * tokens); saving `PUT`s it via {@link useAppsAdminReplaceMutation}, and an empty
 * value clears it back to root-serving (`index.html`). Lifted verbatim from the
 * former apps-editor modal — the only behavioral difference is the page-level
 * (rather than modal-row) layout.
 */
const SelfHostedLaunchPathEditor = ({ app }: { readonly app: SelfHostedEntry }): JSX.Element => {
  const replaceMutation = useAppsAdminReplaceMutation()
  const [launchPath, setLaunchPath] = useState(app.launchPath ?? '')

  return (
    <form
      className={formStyles['form']}
      onSubmit={(event) => {
        event.preventDefault()
        replaceMutation.mutate({
          id: app.id,
          payload: { provenance: 'self-hosted', launchPath: launchPath.trim() },
        })
      }}
    >
      {replaceMutation.error !== null ? (
        <p className={cn(formStyles['error'], 'text-body-3')} role="alert">
          {formatError(replaceMutation.error)}
        </p>
      ) : null}
      <TextField
        label="Launch path"
        value={launchPath}
        placeholder="/launch.html?launch={launch}&iss={origin}/fhir-r4"
        description="Supports the {origin} and {launch} tokens; empty serves index.html."
        disabled={replaceMutation.isPending}
        onChange={(next) => {
          // Clear any prior error as the user resumes editing.
          if (replaceMutation.error !== null) replaceMutation.reset()
          setLaunchPath(next)
        }}
      />
      <div className={formStyles['actions']}>
        <button type="submit" className="button-2 filled" disabled={replaceMutation.isPending}>
          Save launch path
        </button>
      </div>
    </form>
  )
}

export { CloudAppFields, CloudEditForm, SelfHostedLaunchPathEditor, formatError }
export type { CloudEntry, CloudFields, SelfHostedEntry }
