import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { AsyncErrorView, ErrorBanner, PageHeader } from 'react-tundraish'

import { useCloudAppCreateMutation } from '../../../queries.ts'
import { CloudAppFields, type CloudFields } from './-forms.tsx'
import formStyles from './-forms.module.css'

const EMPTY_CLOUD: CloudFields = { name: '', subtitle: '', url: '', requiresTunnel: false }

interface NewAppBodyProps {
  /** Called after a successful create — the route navigates back to the list. */
  readonly onCreated: () => void
}

/**
 * The create-app page: a cloud app's fields, posted as JSON to `POST /cloud-apps`
 * via {@link useCloudAppCreateMutation} (system apps are seeded, not user-added).
 * On success it invokes `onCreated`. Presentational + prop-driven (the
 * navigation callback is injected) so it renders in tests without a live router.
 */
const NewAppBody = ({ onCreated }: NewAppBodyProps): JSX.Element => {
  const createMutation = useCloudAppCreateMutation()
  const [cloud, setCloud] = useState<CloudFields>(EMPTY_CLOUD)

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

  return (
    <>
      <PageHeader title="Add app" backHref="/settings/apps" backLabel="Apps" />
      <form
        className={formStyles['form']}
        onSubmit={(event) => {
          event.preventDefault()
          submitCloud()
        }}
      >
        <ErrorBanner error={createMutation.error} />
        <CloudAppFields fields={cloud} onChange={setCloud} disabled={createMutation.isPending} />
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
