import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Dialog } from 'react-tundraish'

import {
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminUpdateMutation,
  type AppEntry,
} from '../queries.ts'
import editorStyles from '../styles/apps-editor.module.css'

interface AppsEditorProps {
  readonly open: boolean
  readonly apps: readonly AppEntry[]
  readonly onClose: () => void
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Modal editor for the apps list. Bundled apps toggle on/off; custom
 * apps can be added or removed. Writes are issued through the slice's
 * TanStack Query mutations (`useAppsAdmin{Update,Create,Delete}Mutation`),
 * which invalidate the cached apps list on success — the parent screen
 * re-renders with the new data without any prop drilling.
 *
 * Every input lives inside a `<fieldset disabled={busy}>` so the entire
 * form locks during an in-flight write, not just the submit button —
 * stops the user from racing toggles or adding a duplicate custom row
 * while a previous write is still pending.
 */
const AppsEditor = ({ open, apps, onClose }: AppsEditorProps): JSX.Element => {
  const updateMutation = useAppsAdminUpdateMutation()
  const createMutation = useAppsAdminCreateMutation()
  const deleteMutation = useAppsAdminDeleteMutation()
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newRequiresTunnel, setNewRequiresTunnel] = useState(false)

  // Any in-flight write locks the whole fieldset. Aggregating across the
  // three mutations keeps the "one write at a time" guarantee the
  // original imperative flow had.
  const busy = updateMutation.isPending || createMutation.isPending || deleteMutation.isPending
  const submitError = updateMutation.error ?? createMutation.error ?? deleteMutation.error
  const errorMessage = submitError === null ? null : formatError(submitError)

  const toggle = (app: AppEntry): void => {
    updateMutation.mutate({ id: app.id, payload: { enabled: !app.enabled } })
  }

  const removeCustom = (app: AppEntry): void => {
    deleteMutation.mutate({ id: app.id })
  }

  const submitNewCustom = (): void => {
    const name = newName.trim()
    const url = newUrl.trim()
    if (name === '' || url === '') return
    createMutation.mutate(
      { name, url, requiresTunnel: newRequiresTunnel },
      {
        onSuccess: () => {
          setNewName('')
          setNewUrl('')
          setNewRequiresTunnel(false)
        },
      }
    )
  }

  const nonCustom = apps.filter((app) => app.kind !== 'custom')
  const custom = apps.filter((app) => app.kind === 'custom')

  return (
    <Dialog open={open} onClose={onClose} title="Manage apps">
      {errorMessage !== null ? (
        <p className="text-body-3" role="alert">
          {errorMessage}
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
                  toggle(app)
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
                  removeCustom(app)
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
              submitNewCustom()
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
