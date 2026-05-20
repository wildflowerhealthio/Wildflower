import { AppsAdminHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Dialog } from 'react-tundraish'

import { useAppsAdminEffectAction } from '../apps-client.tsx'
import editorStyles from '../styles/apps-editor.module.css'

type AppEntry = Schema.Schema.Type<typeof Schemas.AppEntrySchema>

interface AppsEditorProps {
  readonly open: boolean
  readonly apps: readonly AppEntry[]
  readonly onClose: () => void
  readonly onChanged: () => void
}

/**
 * Modal editor for the apps list. Bundled apps toggle on/off; custom
 * apps can be added or removed. Writes are issued through
 * `useAppsAdminEffectAction` (a one-off Effect runner that
 * auto-provides the slice's *admin* client layer + bearer token —
 * `AppsAdminApi` is owner-only).
 *
 * Every input lives inside a `<fieldset disabled={busy}>` so the entire
 * form locks during an in-flight write, not just the submit button —
 * stops the user from racing toggles or adding a duplicate custom row
 * while a previous write is still pending.
 */
const AppsEditor = ({ open, apps, onClose, onChanged }: AppsEditorProps): JSX.Element => {
  const run = useAppsAdminEffectAction()
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newRequiresTunnel, setNewRequiresTunnel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (app: AppEntry): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].UpdateApp({ path: { id: app.id }, payload: { enabled: !app.enabled } })
        )
      )
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeCustom = async (app: AppEntry): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].DeleteApp({ path: { id: app.id } })
        )
      )
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitNewCustom = async (): Promise<void> => {
    const name = newName.trim()
    const url = newUrl.trim()
    if (name === '' || url === '') {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].CreateCustomApp({
            payload: { name, url, requiresTunnel: newRequiresTunnel },
          })
        )
      )
      setNewName('')
      setNewUrl('')
      setNewRequiresTunnel(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const nonCustom = apps.filter((app) => app.kind !== 'custom')
  const custom = apps.filter((app) => app.kind === 'custom')

  return (
    <Dialog open={open} onClose={onClose} title="Manage apps">
      {error !== null ? (
        <p className="text-body-3" role="alert">
          {error}
        </p>
      ) : null}
      <fieldset className={editorStyles['apps-editor__fieldset']} disabled={busy}>
        <section className={editorStyles['apps-editor__section']}>
          <h3 className="text-label-3">Bundled</h3>
          {nonCustom.map((app) => (
            <div key={app.id} className={editorStyles['apps-editor__row']}>
              <div className={editorStyles['apps-editor__row-label']}>
                <span className="text-body-2">{app.name}</span>
                {app.subtitle !== undefined ? (
                  <span className={cn(editorStyles['apps-editor__row-sub'], 'text-body-3')}>
                    {app.subtitle}
                  </span>
                ) : null}
              </div>
              <Checkbox
                checked={app.enabled}
                label=""
                onChange={() => {
                  void toggle(app)
                }}
              />
            </div>
          ))}
        </section>

        <section className={editorStyles['apps-editor__section']}>
          <h3 className="text-label-3">Custom</h3>
          {custom.map((app) => (
            <div key={app.id} className={editorStyles['apps-editor__row']}>
              <div className={editorStyles['apps-editor__row-label']}>
                <span className="text-body-2">{app.name}</span>
                {app.subtitle !== undefined ? (
                  <span className={cn(editorStyles['apps-editor__row-sub'], 'text-body-3')}>
                    {app.subtitle}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="button-3 outline accent-red"
                onClick={() => {
                  void removeCustom(app)
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <form
            className={editorStyles['apps-editor__form']}
            onSubmit={(event) => {
              event.preventDefault()
              void submitNewCustom()
            }}
          >
            <label className={editorStyles['apps-editor__form-field']}>
              <span className="text-label-3">Name</span>
              <input
                className="input-2"
                value={newName}
                onChange={(event) => {
                  setNewName(event.target.value)
                }}
                required
              />
            </label>
            <label className={editorStyles['apps-editor__form-field']}>
              <span className="text-label-3">
                URL (supports {'{origin}'} and {'{launch}'} tokens)
              </span>
              <input
                className="input-2"
                value={newUrl}
                onChange={(event) => {
                  setNewUrl(event.target.value)
                }}
                required
              />
            </label>
            <Checkbox
              checked={newRequiresTunnel}
              label="Requires tunnel"
              onChange={(checked) => {
                setNewRequiresTunnel(checked)
              }}
            />
            <button type="submit" className="button-2 filled">
              Add custom app
            </button>
          </form>
        </section>
      </fieldset>
    </Dialog>
  )
}

export { AppsEditor }
export type { AppsEditorProps }
