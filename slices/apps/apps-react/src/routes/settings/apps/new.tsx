import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Field, FieldDescription, PageHeader, TextField } from 'react-tundraish'

import { useAppsAdminCreateMutation, useSelfHostedAppCreateMutation } from '../../../queries.ts'
import { CloudAppFields, formatError, type CloudFields } from './-forms.tsx'
import formStyles from './-forms.module.css'

/** The two creatable provenances (system apps are compiled in, not user-added). */
type Mode = 'cloud' | 'self-hosted'

const MODE_OPTIONS: readonly { readonly value: Mode; readonly label: string }[] = [
  { value: 'cloud', label: 'Cloud' },
  { value: 'self-hosted', label: 'Self-hosted' },
]

const EMPTY_CLOUD: CloudFields = { name: '', subtitle: '', url: '', requiresTunnel: false }

interface NewAppBodyProps {
  /** Called after a successful create — the route navigates back to the list. */
  readonly onCreated: () => void
}

/**
 * The create-app page. A full-width tabs picker switches between the **cloud**
 * arm (a URL template + requires-tunnel, via {@link useAppsAdminCreateMutation})
 * and the **self-hosted** arm (a name + subtitle + uploaded `.zip` bundle, via
 * {@link useSelfHostedAppCreateMutation}). Both POST the single merged
 * `multipart/form-data` create route, discriminated on `provenance`, and on
 * success invoke `onCreated`. Presentational + prop-driven (the navigation
 * callback is injected) so it renders in tests without a live router.
 */
const NewAppBody = ({ onCreated }: NewAppBodyProps): JSX.Element => {
  const [mode, setMode] = useState<Mode>('cloud')
  const createMutation = useAppsAdminCreateMutation()
  const selfHostedMutation = useSelfHostedAppCreateMutation()
  const [cloud, setCloud] = useState<CloudFields>(EMPTY_CLOUD)
  const [selfHostedName, setSelfHostedName] = useState('')
  const [selfHostedSubtitle, setSelfHostedSubtitle] = useState('')
  const [selfHostedFile, setSelfHostedFile] = useState<File | null>(null)

  const submitCloud = (): void => {
    const name = cloud.name.trim()
    const url = cloud.url.trim()
    if (name === '' || url === '') return
    const subtitle = cloud.subtitle.trim()
    createMutation.mutate(
      {
        name,
        url,
        requiresTunnel: cloud.requiresTunnel,
        // Empty subtitle is omitted so the server stores "no subtitle".
        ...(subtitle === '' ? {} : { subtitle }),
      },
      { onSuccess: onCreated }
    )
  }

  const submitSelfHosted = (): void => {
    const name = selfHostedName.trim()
    if (name === '' || selfHostedFile === null) return
    const subtitle = selfHostedSubtitle.trim()
    // The picked zip rides the merged create route as the `bundle` file part of
    // a multipart form (the server extracts + installs it).
    selfHostedMutation.mutate(
      { name, bundle: selfHostedFile, ...(subtitle === '' ? {} : { subtitle }) },
      { onSuccess: onCreated }
    )
  }

  return (
    <>
      <PageHeader title="Add app" backHref="/settings/apps" backLabel="Apps" />
      <div className={formStyles['tabs']} role="tablist" aria-label="App type">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            className={cn(
              formStyles['tab'],
              mode === option.value ? formStyles['tab--active'] : null
            )}
            onClick={() => {
              setMode(option.value)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'cloud' ? (
        <form
          className={formStyles['form']}
          onSubmit={(event) => {
            event.preventDefault()
            submitCloud()
          }}
        >
          {createMutation.error !== null ? (
            <p className={cn(formStyles['error'], 'text-body-3')} role="alert">
              {formatError(createMutation.error)}
            </p>
          ) : null}
          <CloudAppFields fields={cloud} onChange={setCloud} disabled={createMutation.isPending} />
          <div className={formStyles['actions']}>
            <button type="submit" className="button-2 filled" disabled={createMutation.isPending}>
              Add app
            </button>
          </div>
        </form>
      ) : (
        <form
          className={formStyles['form']}
          onSubmit={(event) => {
            event.preventDefault()
            submitSelfHosted()
          }}
        >
          {selfHostedMutation.error !== null ? (
            <p className={cn(formStyles['error'], 'text-body-3')} role="alert">
              {formatError(selfHostedMutation.error)}
            </p>
          ) : null}
          <TextField
            label="Name"
            value={selfHostedName}
            disabled={selfHostedMutation.isPending}
            onChange={setSelfHostedName}
          />
          <TextField
            label="Subtitle"
            value={selfHostedSubtitle}
            description="Optional — shown under the app name."
            disabled={selfHostedMutation.isPending}
            onChange={setSelfHostedSubtitle}
          />
          <Field label="Bundle (.zip)" htmlFor="new-app-bundle">
            <input
              id="new-app-bundle"
              className="input-2"
              type="file"
              accept=".zip,application/zip"
              disabled={selfHostedMutation.isPending}
              onChange={(event) => {
                setSelfHostedFile(event.target.files?.[0] ?? null)
              }}
            />
            <FieldDescription>
              The built app, zipped. It's served from its own isolated local origin.
            </FieldDescription>
          </Field>
          <div className={formStyles['actions']}>
            <button
              type="submit"
              className="button-2 filled"
              disabled={selfHostedMutation.isPending}
            >
              Add self-hosted app
            </button>
          </div>
        </form>
      )}
    </>
  )
}

const NewAppScreen = (): JSX.Element => {
  const navigate = useNavigate()
  return (
    <NewAppBody
      onCreated={() => {
        void navigate({ to: '/settings/apps' })
      }}
    />
  )
}

/**
 * The `/settings/apps/new` file route — the create page. No loader (it reads no
 * data); the `/settings` `beforeLoad` gate still guarantees a token for the
 * create POST.
 */
const Route = createFileRoute('/settings/apps/new')({
  component: NewAppScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Add app" />,
})

export { NewAppBody, Route }
