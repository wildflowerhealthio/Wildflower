import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Schema } from 'effect'
import { defaultConfig } from 'fhir-r4-client-collector'
import { unknownErrorToString } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageHeader, pageLayoutStyles } from 'react-tundraish'

import { useCreateRemoteMutation } from '../../../queries/index.ts'
import accountConfig from './account-config.module.css'
import pageLayout from './page-layout.module.css'

const AccountNewSearch = Schema.Struct({
  prefillName: Schema.optional(Schema.String),
  prefillRootUrl: Schema.optional(Schema.String),
  prefillPatientId: Schema.optional(Schema.String),
})
type AccountNewSearch = Schema.Schema.Type<typeof AccountNewSearch>

/**
 * Create a new FHIR R4 remote. Mounted at `/collector/account/new`;
 * the prefill fields are optionally handed off by the source list on
 * `/collector` so a user landing on this screen from "Demo FHIR Server"
 * sees the defaults pre-populated. The schema decodes (and runtime-checks
 * presence/absence/type of) the URL search in `validateSearch`.
 */
function AccountNewScreen({
  prefillName,
  prefillRootUrl,
  prefillPatientId,
}: AccountNewSearch): JSX.Element {
  const navigate = useNavigate()
  const createMutation = useCreateRemoteMutation()
  const [name, setName] = useState(prefillName ?? '')
  const [rootUrl, setRootUrl] = useState(prefillRootUrl ?? defaultConfig.rootUrl)
  const [patientId, setPatientId] = useState(prefillPatientId ?? defaultConfig.patientId)

  const error = createMutation.error === null ? null : unknownErrorToString(createMutation.error)

  const handleSave = (): void => {
    const remoteName = name === '' ? `FHIR R4 ${new Date().toLocaleDateString()}` : name
    createMutation.mutate(
      {
        id: crypto.randomUUID(),
        name: remoteName,
        config: { _tag: 'fhir-r4', rootUrl, patientId },
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
      <PageHeader title="Add Account" backHref="/collector" />

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
 * The `/collector/account/new` route. `validateSearch` decodes the URL
 * search with `AccountNewSearch` at the router boundary; the component
 * reads it back through the generated, typed `Route.useSearch()`.
 */
function AccountNewRoute(): JSX.Element {
  const { prefillName, prefillRootUrl, prefillPatientId } = Route.useSearch()
  return (
    <AccountNewScreen
      prefillName={prefillName}
      prefillRootUrl={prefillRootUrl}
      prefillPatientId={prefillPatientId}
    />
  )
}

const Route = createFileRoute('/_auth/collector/account/new')({
  validateSearch: Schema.standardSchemaV1(AccountNewSearch),
  component: AccountNewRoute,
})

export { AccountNewSearch, Route }
