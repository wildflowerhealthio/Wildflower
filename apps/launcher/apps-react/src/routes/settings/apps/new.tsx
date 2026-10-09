import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { AsyncErrorView, ErrorBanner, PageHeader } from 'react-tundraish'

import { useAppCreateMutation } from '../../../queries.ts'
import { AppFieldInputs, appBodyFrom, type AppFields } from './-forms.tsx'
import formStyles from './-forms.module.css'

const EMPTY_FIELDS: AppFields = { name: '', subtitle: '', url: '', requiresTunnel: false }

interface NewAppBodyProps {
  /** Called after a successful create — the route navigates back to the list. */
  readonly onCreated: () => void
}

/**
 * The create-app page: an app's fields, posted as JSON to `POST /apps` via
 * {@link useAppCreateMutation}. On success it invokes `onCreated`. Presentational + prop-driven (the
 * navigation callback is injected) so it renders in tests without a live router.
 */
const NewAppBody = ({ onCreated }: NewAppBodyProps): JSX.Element => {
  const createMutation = useAppCreateMutation()
  const [fields, setFields] = useState<AppFields>(EMPTY_FIELDS)

  const submit = (): void => {
    const body = appBodyFrom(fields)
    if (body === undefined) return
    createMutation.mutate(body, { onSuccess: onCreated })
  }

  return (
    <>
      <PageHeader title="Add app" backHref="/settings/apps" backLabel="Apps" />
      <form
        className={formStyles['form']}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <ErrorBanner error={createMutation.error} />
        <AppFieldInputs fields={fields} onChange={setFields} disabled={createMutation.isPending} />
        <div className={formStyles['actions']}>
          <button
            type="submit"
            className="button-2 filled"
            style={{ width: '100%' }}
            disabled={createMutation.isPending}
          >
            Add
          </button>
        </div>
      </form>
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
