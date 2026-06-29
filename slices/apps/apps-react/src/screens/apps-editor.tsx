import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Dialog } from 'react-tundraish'

import {
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useReplaceHomeScreenMutation,
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
 * Modal editor for the apps list. Only **cloud** apps expose controls here —
 * the cloud-admin `Delete` surface `409 AppNotEditable`s system and self-hosted
 * apps, so those rows render read-only (no enable-toggle, no Remove). The
 * enable-toggle persists through `PUT /home-screen` (the single writer of order +
 * `enabled`, all provenances) by re-PUTting the whole list with the one flag
 * flipped; reordering itself lives on the homescreen drag. New (cloud) apps are
 * created and cloud apps removed through the cloud-admin mutations. Writes are
 * issued through the slice's TanStack Query mutations, which invalidate the
 * cached apps list on success — the parent screen re-renders with the new data
 * without any prop drilling.
 *
 * Every input lives inside a `<fieldset disabled={busy}>` so the entire
 * form locks during an in-flight write, not just the submit button —
 * stops the user from racing toggles or adding a duplicate row while a
 * previous write is still pending.
 *
 * The host `Dialog` (react-tundraish) keeps its children mounted while
 * closed, so the three mutations' `error` state would otherwise persist
 * and a stale error would reappear on the next open. An effect keyed on
 * `open` resets all three mutations (and clears the new-app form fields)
 * whenever the dialog transitions to open, so each open starts from a
 * clean slate.
 */
const AppsEditor = ({ open, apps, onClose }: AppsEditorProps): JSX.Element => {
  const homeScreenMutation = useReplaceHomeScreenMutation()
  const createMutation = useAppsAdminCreateMutation()
  const deleteMutation = useAppsAdminDeleteMutation()
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newRequiresTunnel, setNewRequiresTunnel] = useState(false)

  // `Dialog` does not unmount its children when closed, so a settled
  // mutation hangs onto its last `error` until the next `mutate`. Without
  // this, reopening the dialog after a failed write would flash the stale
  // error before any new interaction. Resetting on the open transition
  // (and clearing the new-app form) gives every open a clean slate.
  // `.reset` is a plain function (not an Effect), so calling it directly
  // in a sync effect is safe — no `Effect.runFork` needed. The mutation
  // `reset` identities are stable across renders, so listing them keeps
  // the exhaustive-deps lint satisfied without re-running on every render.
  const resetHomeScreen = homeScreenMutation.reset
  const resetCreate = createMutation.reset
  const resetDelete = deleteMutation.reset
  useEffect(() => {
    if (!open) return
    resetHomeScreen()
    resetCreate()
    resetDelete()
    setNewName('')
    setNewUrl('')
    setNewRequiresTunnel(false)
  }, [open, resetHomeScreen, resetCreate, resetDelete])

  // Any in-flight write locks the whole fieldset. Aggregating across the
  // three mutations keeps the "one write at a time" guarantee the
  // original imperative flow had.
  const busy = homeScreenMutation.isPending || createMutation.isPending || deleteMutation.isPending
  const homeScreenError = homeScreenMutation.error ?? deleteMutation.error
  const errorMessage = homeScreenError === null ? null : formatError(homeScreenError)

  // Enabled is homescreen-curation state: persist it by re-PUTting the whole
  // ordered list with this app's flag flipped (the single writer of `enabled`).
  const toggle = (app: AppEntry): void => {
    homeScreenMutation.mutate(
      apps.map((entry) => ({
        id: entry.id,
        enabled: entry.id === app.id ? !entry.enabled : entry.enabled,
      }))
    )
  }

  const remove = (app: AppEntry): void => {
    deleteMutation.mutate({ id: app.id })
  }

  const submitNewApp = (): void => {
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

  return (
    <Dialog open={open} onClose={onClose} title="Manage apps">
      {errorMessage !== null ? (
        <p className="text-body-3" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <fieldset className={editorStyles['apps-editor__fieldset']} disabled={busy}>
        <section className={editorStyles['apps-editor__section']}>
          {apps.map((app) => (
            <div key={app.id} className={editorStyles['apps-editor__row']}>
              <div className={editorStyles['apps-editor__row-label']}>
                <span className="text-body-2">{app.name}</span>
                {app.subtitle !== undefined ? (
                  <span className={cn(editorStyles['apps-editor__row-sub'], 'text-body-3')}>
                    {app.subtitle}
                  </span>
                ) : null}
              </div>
              {/*
               * Only cloud apps are editable through the cloud-admin surface;
               * the Update/Delete endpoints `409` for system/self-hosted. Those
               * rows render read-only — a provenance tag stands in for the
               * controls so the user can see why the row can't be edited.
               * Enable/reorder for every provenance happens on the homescreen
               * (the placement endpoint), not here.
               */}
              {app.provenance === 'cloud' ? (
                <div className={editorStyles['apps-editor__row-actions']}>
                  <Checkbox
                    checked={app.enabled}
                    label=""
                    onChange={() => {
                      toggle(app)
                    }}
                  />
                  <button
                    type="button"
                    className="button-3 outline accent-red"
                    onClick={() => {
                      remove(app)
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className={cn(editorStyles['apps-editor__row-readonly'], 'text-body-3')}>
                  {app.provenance === 'system' ? 'System' : 'Self-hosted'}
                </span>
              )}
            </div>
          ))}
        </section>

        <section className={editorStyles['apps-editor__section']}>
          <h3 className="text-label-3">Add app</h3>

          {createMutation.error !== null ? (
            <p className="text-body-3" role="alert">
              {formatError(createMutation.error)}
            </p>
          ) : null}
          <form
            className={editorStyles['apps-editor__form']}
            onSubmit={(event) => {
              event.preventDefault()
              submitNewApp()
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
              Add app
            </button>
          </form>
        </section>
      </fieldset>
    </Dialog>
  )
}

export { AppsEditor }
export type { AppsEditorProps }
