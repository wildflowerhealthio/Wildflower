import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Remotes } from 'collector-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { defaultConfig } from 'fhir-r4-client-collector'
import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { pageLayoutStyles } from 'react-tundraish'

import { useCollectorEffectAction } from '../collector-client.tsx'
import accountConfig from '../styles/account-config.module.css'
import pageLayout from '../styles/page-layout.module.css'

type RemoteRow = Schema.Schema.Type<typeof Remotes.RemoteSchema>

/**
 * Edit or create a FHIR R4 remote. Mounted at `/collector/account/:id`
 * for edit mode (the row is loaded by the path param) and at
 * `/collector/account/new` for create mode (optionally prefilled from
 * `prefill*` query params handed off by the source list).
 */
const AccountConfigScreen = (): JSX.Element => {
  const navigate = useNavigate()
  const run = useCollectorEffectAction()
  const { id: accountId } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const prefillName = searchParams.get('prefillName')
  const prefillRootUrl = searchParams.get('prefillRootUrl')
  const prefillPatientId = searchParams.get('prefillPatientId')

  const [existing, setExisting] = useState<RemoteRow | null>(null)
  const [loading, setLoading] = useState(accountId !== undefined)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState(prefillName ?? '')
  const [rootUrl, setRootUrl] = useState(prefillRootUrl ?? defaultConfig.rootUrl)
  const [patientId, setPatientId] = useState(prefillPatientId ?? defaultConfig.patientId)

  useEffect(() => {
    if (accountId === undefined) return () => undefined
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
        existing !== null && accountId !== undefined
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
      void navigate('/collector')
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
          onClick={() => void navigate('/collector')}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export { AccountConfigScreen }
