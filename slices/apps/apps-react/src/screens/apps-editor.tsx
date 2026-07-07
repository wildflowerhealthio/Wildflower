import { useIsMutating } from '@tanstack/react-query'
import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Dialog } from 'react-tundraish'

import {
  HOME_SCREEN_MUTATION_KEY,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useReplaceHomeScreenMutation,
  useSelfHostedAppCreateMutation,
  type AppEntry,
} from '../queries.ts'
import { provenanceLabel } from '../routes/_auth/home/-tiles.tsx'
import editorStyles from '../styles/apps-editor.module.css'

interface AppsEditorProps {
  readonly open: boolean
  readonly apps: readonly AppEntry[]
  readonly onClose: () => void
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Modal editor for the apps list. The enable-toggle is exposed for **every**
 * provenance — it persists through `PUT /home-screen` (the single writer of
 * order + `enabled`, all provenances) by re-PUTting the whole list with the one
 * flag flipped; reordering itself lives on the homescreen drag. Removal is gated
 * on each row's `removable` flag (computed server-side): cloud apps and uploaded
 * self-hosted apps get a `Remove` button, while system apps and the seeded
 * self-hosted apps show a read-only provenance tag beside their toggle instead.
 * The editor also installs new apps: cloud apps via the "Add app" URL form, and
 * self-hosted apps via the "Add self-hosted app" zip upload. Writes are issued
 * through the slice's TanStack Query mutations, which invalidate the cached apps
 * list on success — the parent screen re-renders with the new data without any
 * prop drilling.
 *
 * Every input lives inside a `<fieldset disabled={busy}>` so the entire
 * form locks during an in-flight write, not just the submit button. `busy`
 * folds in {@link useIsMutating} for the shared home-screen key, so a toggle is
 * disabled not only during this editor's own writes but also while the home
 * screen's drag-reorder PUT is still landing — without that, toggling would
 * re-PUT the pre-reorder `apps` order and silently revert the just-made drag.
 *
 * The host `Dialog` (react-tundraish) keeps its children mounted while
 * closed, so the mutations' `error` state would otherwise persist and a
 * stale error would reappear on the next open. An effect keyed on `open`
 * resets every mutation (and clears both new-app forms' fields) whenever the
 * dialog transitions to open, so each open starts from a clean slate.
 */
const AppsEditor = ({ open, apps, onClose }: AppsEditorProps): JSX.Element => {
  const homeScreenMutation = useReplaceHomeScreenMutation()
  const createMutation = useAppsAdminCreateMutation()
  const deleteMutation = useAppsAdminDeleteMutation()
  const selfHostedMutation = useSelfHostedAppCreateMutation()
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newRequiresTunnel, setNewRequiresTunnel] = useState(false)
  const [selfHostedName, setSelfHostedName] = useState('')
  const [selfHostedFile, setSelfHostedFile] = useState<File | null>(null)
  // Bumped to remount the (uncontrolled) file `<input>` so a successful upload
  // or an open-transition reset clears the picked filename.
  const [fileInputKey, setFileInputKey] = useState(0)

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
  const resetSelfHosted = selfHostedMutation.reset
  useEffect(() => {
    if (!open) return
    resetHomeScreen()
    resetCreate()
    resetDelete()
    resetSelfHosted()
    setNewName('')
    setNewUrl('')
    setNewRequiresTunnel(false)
    setSelfHostedName('')
    setSelfHostedFile(null)
    setFileInputKey((key) => key + 1)
  }, [open, resetHomeScreen, resetCreate, resetDelete, resetSelfHosted])

  // Any in-flight write locks the whole fieldset. `homeScreenInFlight` counts
  // *every* `PUT /home-screen` writer sharing the key — this editor's own toggle
  // AND the home screen's drag-reorder — so a toggle is disabled while a reorder
  // is still landing (it subsumes `homeScreenMutation.isPending`). Aggregating
  // with create/delete keeps the "one write at a time" guarantee.
  const homeScreenInFlight = useIsMutating({ mutationKey: HOME_SCREEN_MUTATION_KEY }) > 0
  const busy =
    homeScreenInFlight ||
    createMutation.isPending ||
    deleteMutation.isPending ||
    selfHostedMutation.isPending
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

  const submitSelfHostedApp = async (): Promise<void> => {
    const name = selfHostedName.trim()
    if (name === '' || selfHostedFile === null) return
    // Read the picked zip into raw bytes; the mutation sends them as the
    // `application/zip` request body (the server extracts + installs them).
    const bytes = new Uint8Array(await selfHostedFile.arrayBuffer())
    selfHostedMutation.mutate(
      { name, bytes },
      {
        onSuccess: () => {
          setSelfHostedName('')
          setSelfHostedFile(null)
          setFileInputKey((key) => key + 1)
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
               * The enable toggle is shown for every provenance — `enabled` is
               * homescreen curation, persisted via `PUT /home-screen`, which
               * accepts all provenances. A `Remove` button shows only when the
               * server marks the row `removable` (cloud apps + uploaded
               * self-hosted apps); a non-removable row (system + seeded
               * self-hosted, which the admin surface `409`s) shows a read-only
               * provenance tag in its place so the user can see why it can't be
               * removed.
               */}
              <div className={editorStyles['apps-editor__row-actions']}>
                <Checkbox
                  checked={app.enabled}
                  label=""
                  onChange={() => {
                    toggle(app)
                  }}
                />
                {app.removable ? (
                  <button
                    type="button"
                    className="button-3 outline accent-red"
                    onClick={() => {
                      remove(app)
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <span className={cn(editorStyles['apps-editor__row-readonly'], 'text-body-3')}>
                    {provenanceLabel(app.provenance)}
                  </span>
                )}
              </div>
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

        <section className={editorStyles['apps-editor__section']}>
          <h3 className="text-label-3">Add self-hosted app</h3>

          {selfHostedMutation.error !== null ? (
            <p className="text-body-3" role="alert">
              {formatError(selfHostedMutation.error)}
            </p>
          ) : null}
          <form
            className={editorStyles['apps-editor__form']}
            onSubmit={(event) => {
              event.preventDefault()
              void submitSelfHostedApp()
            }}
          >
            <label className={editorStyles['apps-editor__form-field']}>
              <span className="text-label-3">Name</span>
              <input
                className="input-2"
                value={selfHostedName}
                onChange={(event) => {
                  setSelfHostedName(event.target.value)
                }}
                required
              />
            </label>
            <label className={editorStyles['apps-editor__form-field']}>
              <span className="text-label-3">Bundle (.zip)</span>
              <input
                key={fileInputKey}
                className="input-2"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  setSelfHostedFile(event.target.files?.[0] ?? null)
                }}
                required
              />
            </label>
            <button type="submit" className="button-2 filled">
              Add self-hosted app
            </button>
          </form>
        </section>
      </fieldset>
    </Dialog>
  )
}

export { AppsEditor }
export type { AppsEditorProps }
