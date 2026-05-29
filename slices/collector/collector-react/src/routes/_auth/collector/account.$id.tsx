import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Remotes } from 'collector-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { defaultConfig } from 'fhir-r4-client-collector'
import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles } from 'react-tundraish'

import { useCollectorEffectAction } from '../../../collector-client.tsx'
import accountConfig from './account-config.module.css'
import pageLayout from './page-layout.module.css'

type RemoteRow = Schema.Schema.Type<typeof Remotes.RemoteSchema>

/**
 * Edit an existing FHIR R4 remote. Mounted at `/collector/account/$id`;
 * the row is loaded by the path param.
 */
function AccountConfigScreen({ accountId }: { readonly accountId: string }): JSX.Element {
  const navigate = useNavigate()
  const run = useCollectorEffectAction()
  const [existing, setExisting] = useState<RemoteRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [rootUrl, setRootUrl] = useState(defaultConfig.rootUrl)
  const [patientId, setPatientId] = useState(defaultConfig.patientId)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const remote = await run(
          Effect.flatMap(CollectorHttpApiClient, (c) =>
            c['collector-remotes'].GetRemote({ path: { id: accountId } })
          )
        )
        if (!cancelled) {
          setExisting(remote)
          setName(remote.name)
          const rootUrlVal = remote.config['rootUrl']
          const patientIdVal = remote.config['patientId']
          setRootUrl(typeof rootUrlVal === 'string' ? rootUrlVal : defaultConfig.rootUrl)
          setPatientId(typeof patientIdVal === 'string' ? patientIdVal : defaultConfig.patientId)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [accountId, run])

  const handleSave = async (): Promise<void> => {
    const remoteName = name === '' ? `FHIR R4 ${new Date().toLocaleDateString()}` : name
    try {
      const operation =
        existing !== null
          ? Effect.flatMap(CollectorHttpApiClient, (c) =>
              c['collector-remotes'].UpdateRemote({
                path: { id: accountId },
                payload: {
                  name: remoteName,
                  config: { _tag: 'fhir-r4', rootUrl, patientId },
                },
              })
            )
          : Effect.flatMap(CollectorHttpApiClient, (c) =>
              c['collector-remotes'].CreateRemote({
                payload: {
                  id: crypto.randomUUID(),
                  name: remoteName,
                  config: { _tag: 'fhir-r4', rootUrl, patientId },
                },
              })
            )
      await run(operation)
      void navigate({ to: '/collector' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) {
    return (
      <div className={pageLayoutStyles['page']}>
        <p className="text-body-2">Loading…</p>
      </div>
    )
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <h2 className="text-heading-4">{existing !== null ? 'Edit Account' : 'Add Account'}</h2>

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
        <button type="button" className="button-2 filled" onClick={() => void handleSave()}>
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
    </div>
  )
}

/**
 * The `/collector/account/$id` route. Reads the typed `$id` path param
 * from the generated route via `Route.useParams()` and hands it to the
 * screen as a prop.
 */
function AccountConfigRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <AccountConfigScreen accountId={id} />
}

export const Route = createFileRoute('/_auth/collector/account/$id')({
  component: AccountConfigRoute,
})
