import { AppsHttpApiClient } from 'apps-core/clients'
import type { Apps } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import { useAppsEffectRunner } from '../use-apps-effect-runner.ts'
import editorStyles from '../styles/apps-editor.module.css'

type AppEntry = Schema.Schema.Type<typeof Apps.AppEntrySchema>

interface AppsEditorProps {
  readonly open: boolean
  readonly apps: readonly AppEntry[]
  readonly onClose: () => void
  readonly onChanged: () => void
}

/**
 * Modal editor for the apps list. Bundled apps toggle on/off; custom
 * apps can be added or removed. Writes are issued through
 * `useAppsEffectRunner` (a one-off Effect runner that auto-provides the
 * slice client layer + bearer token).
 */
const AppsEditor = ({ open, apps, onClose, onChanged }: AppsEditorProps): JSX.Element => {
  const run = useAppsEffectRunner()
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
        Effect.flatMap(AppsHttpApiClient, (c) =>
          c.apps.UpdateApp({ path: { id: app.id }, payload: { enabled: !app.enabled } })
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
        Effect.flatMap(AppsHttpApiClient, (c) => c.apps.DeleteApp({ path: { id: app.id } }))
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
        Effect.flatMap(AppsHttpApiClient, (c) =>
          c.apps.CreateCustomApp({ payload: { name, url, requiresTunnel: newRequiresTunnel } })
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
      {error !== null ? <p role="alert">{error}</p> : null}
      <section className={editorStyles['section']}>
        <h3 className={editorStyles['sectionTitle']}>Bundled</h3>
        {nonCustom.map((app) => (
          <div key={app.id} className={editorStyles['row']}>
            <div className={editorStyles['rowLabel']}>
              <span className={editorStyles['rowName']}>{app.name}</span>
              <span className={editorStyles['rowSub']}>{app.subtitle}</span>
            </div>
            <label>
              <input
                type="checkbox"
                checked={app.enabled}
                disabled={busy}
                onChange={() => {
                  void toggle(app)
                }}
              />
            </label>
          </div>
        ))}
      </section>

      <section className={editorStyles['section']}>
        <h3 className={editorStyles['sectionTitle']}>Custom</h3>
        {custom.map((app) => (
          <div key={app.id} className={editorStyles['row']}>
            <div className={editorStyles['rowLabel']}>
              <span className={editorStyles['rowName']}>{app.name}</span>
              <span className={editorStyles['rowSub']}>{app.subtitle}</span>
            </div>
            <button
              type="button"
              className={editorStyles['removeButton']}
              disabled={busy}
              onClick={() => {
                void removeCustom(app)
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <form
          className={editorStyles['formGrid']}
          onSubmit={(event) => {
            event.preventDefault()
            void submitNewCustom()
          }}
        >
          <label>
            Name
            <input
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value)
              }}
              required
            />
          </label>
          <label>
            URL (supports {'{origin}'} and {'{launch}'} tokens)
            <input
              value={newUrl}
              onChange={(event) => {
                setNewUrl(event.target.value)
              }}
              required
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={newRequiresTunnel}
              onChange={(event) => {
                setNewRequiresTunnel(event.target.checked)
              }}
            />
            Requires tunnel
          </label>
          <button type="submit" className={editorStyles['submitButton']} disabled={busy}>
            Add custom app
          </button>
        </form>
      </section>
    </Dialog>
  )
}

export { AppsEditor }
export type { AppsEditorProps }
