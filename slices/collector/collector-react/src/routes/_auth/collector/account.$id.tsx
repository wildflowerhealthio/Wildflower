import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { defaultConfig } from 'fhir-r4-client-collector'
import { unknownErrorToString } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, pageLayoutStyles } from 'react-tundraish'

import {
  remoteQueryOptions,
  useRemoteQuery,
  useUpdateRemoteMutation,
  type Remote,
} from '../../../queries/index.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import accountConfig from './account-config.module.css'
import pageLayout from './page-layout.module.css'

/**
 * Edit an existing FHIR R4 remote. Mounted at `/collector/account/$id`;
 * the row is read through `useRemoteQuery` (TanStack Query), warmed by
 * the route `loader`. Saving rides `useUpdateRemoteMutation`, whose
 * `invalidateQueries` refetches the accounts list + this remote's detail.
 */
function AccountConfigScreen({ existing }: { readonly existing: Remote }): JSX.Element {
  const navigate = useNavigate()
  const updateMutation = useUpdateRemoteMutation()
  const [name, setName] = useState(existing.name)
  const [rootUrl, setRootUrl] = useState(
    typeof existing.config['rootUrl'] === 'string'
      ? existing.config['rootUrl']
      : defaultConfig.rootUrl
  )
  const [patientId, setPatientId] = useState(
    typeof existing.config['patientId'] === 'string'
      ? existing.config['patientId']
      : defaultConfig.patientId
  )

  const error = updateMutation.error === null ? null : unknownErrorToString(updateMutation.error)

  const handleSave = (): void => {
    const remoteName = name === '' ? `FHIR R4 ${new Date().toLocaleDateString()}` : name
    updateMutation.mutate(
      {
        id: existing.id,
        payload: { name: remoteName, config: { _tag: 'fhir-r4', rootUrl, patientId } },
      },
      {
        onSuccess: () => {
          void navigate({ to: '/collector' })
        },
      }
    )
  }

  return (
    <>
      <h2 className="text-heading-4">Edit Account</h2>

      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}

      <div className={accountConfig['field']}>
        <label className={cn(accountConfig['field__label'], 'text-label-3')}>Type</label>
        <span className={cn(accountConfig['type-badge'], 'text-body-3')}>FHIR R4</span>
      </div>

      <div className={accountConfig['field']}>
        <label className={cn(accountConfig['field__label'], 'text-label-3')} htmlFor="cl-name">
          Name
        </label>
        <input
          id="cl-name"
          className="input-2"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
          }}
          placeholder="Account name"
        />
      </div>

      <div className={accountConfig['field']}>
        <label className={cn(accountConfig['field__label'], 'text-label-3')} htmlFor="cl-rootUrl">
          Root URL
        </label>
        <input
          id="cl-rootUrl"
          className="input-2"
          value={rootUrl}
          onChange={(e) => {
            setRootUrl(e.target.value)
          }}
          placeholder="Root URL"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className={accountConfig['field']}>
        <label className={cn(accountConfig['field__label'], 'text-label-3')} htmlFor="cl-patientId">
          Patient ID
        </label>
        <input
          id="cl-patientId"
          className="input-2"
          value={patientId}
          onChange={(e) => {
            setPatientId(e.target.value)
          }}
          placeholder="Patient ID"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className={pageLayout['button-row']}>
        <button type="button" className="button-2 filled" onClick={handleSave}>
          Save
        </button>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => void navigate({ to: '/collector' })}
        >
          Cancel
        </button>
      </div>
    </>
  )
}

/**
 * The `/collector/account/$id` route. Reads the typed `$id` path param
 * from the generated route via `Route.useParams()`, fetches the remote
 * through `useRemoteQuery`, and hands the loaded row to the screen.
 */
function AccountConfigRoute(): JSX.Element {
  const { id } = Route.useParams()
  const { data: existing } = useRemoteQuery(id)
  return <AccountConfigScreen existing={existing} />
}

/**
 * The `_auth` gate is a React component (`RequireAuth`), not `beforeLoad`,
 * so the loader fires before auth. {@link ensureAuthedQuery} skips the
 * prefetch when the bearer token isn't ready yet and lets the in-component
 * `useSuspenseQuery` do the real read; genuine read failures (including a
 * 404 `RemoteNotFound`) propagate to `errorComponent`.
 */
export const Route = createFileRoute('/_auth/collector/account/$id')({
  loader: ({ context, params }) =>
    ensureAuthedQuery(context, remoteQueryOptions(context.runAuthed, params.id)),
  component: AccountConfigRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Collector" />,
})
