import { useIsMutating } from '@tanstack/react-query'
import { Fragment, useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Dialog } from 'react-tundraish'

import {
  APP_CONTENT_MUTATION_KEY,
  HOME_SCREEN_MUTATION_KEY,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminReplaceMutation,
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

/** The self-hosted variant of the catalogue union — the only kind with an
 * editable launch path. */
type SelfHostedEntry = Extract<AppEntry, { provenance: 'self-hosted' }>

/**
 * Inline launch-path editor for an uploaded self-hosted app. Prefilled from the
 * stored `launchPath` (a SMART launcher path with `{origin}` / `{launch}`
 * tokens); saving `PUT`s it via {@link useAppsAdminReplaceMutation}, and an empty
 * value clears it back to root-serving (`index.html`). Its own mutation instance
 * keeps each row's in-flight state and error local to that row.
 */
const SelfHostedLaunchPathEditor = ({ app }: { readonly app: SelfHostedEntry }): JSX.Element => {
  const replaceMutation = useAppsAdminReplaceMutation()
  const [launchPath, setLaunchPath] = useState(app.launchPath ?? '')

  return (
    <form
      className={editorStyles['apps-editor__form']}
      onSubmit={(event) => {
        event.preventDefault()
        replaceMutation.mutate({
          id: app.id,
          payload: { provenance: 'self-hosted', launchPath: launchPath.trim() },
        })
      }}
    >
      {replaceMutation.error !== null ? (
        <p className="text-body-3" role="alert">
          {formatError(replaceMutation.error)}
        </p>
      ) : null}
      <label className={editorStyles['apps-editor__form-field']}>
        <span className="text-label-3">
          Launch path (supports {'{origin}'} and {'{launch}'} tokens; empty serves index.html)
        </span>
        <input
          className="input-2"
          value={launchPath}
          placeholder="/launch.html?launch={launch}&iss={origin}/fhir-r4"
          onChange={(event) => {
            // Clear any prior error as the user resumes editing.
            if (replaceMutation.error !== null) replaceMutation.reset()
            setLaunchPath(event.target.value)
          }}
        />
      </label>
      <button type="submit" className="button-3 outline" disabled={replaceMutation.isPending}>
        Save launch path
      </button>
    </form>
  )
}

/**
 * Modal editor for the apps list. The enable-toggle is exposed for **every**
 * provenance — it persists through `PUT /home-screen` (the single writer of
 * order + `enabled`) by re-PUTting the whole list with the one flag flipped;
 * reordering itself lives on the homescreen drag. Removal is gated on each row's
 * server-computed `removable` flag: cloud + uploaded self-hosted apps get a
 * `Remove` button, system + seeded self-hosted apps show a read-only provenance
 * tag instead. The editor also installs new apps (cloud via the URL form,
 * self-hosted via the zip upload). Writes go through the slice's TanStack Query
 * mutations, which invalidate the cached list on success.
 *
 * The whole form locks during any in-flight write (see `busy`), and a
 * mount-persisting `Dialog` means each open resets the mutations and forms (see
 * the open-transition effect).
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
  // is still landing (it subsumes `homeScreenMutation.isPending`).
  // `appContentInFlight` does the same for the per-row launch-path editors,
  // whose mutation instances live in their own components — without it,
  // Remove/toggle would stay live while a launch-path save is mid-flight (and a
  // Remove of that very app would fail its in-txn read-back). Aggregating with
  // create/delete keeps the "one write at a time" guarantee.
  const homeScreenInFlight = useIsMutating({ mutationKey: HOME_SCREEN_MUTATION_KEY }) > 0
  const appContentInFlight = useIsMutating({ mutationKey: APP_CONTENT_MUTATION_KEY }) > 0
  const busy =
    homeScreenInFlight ||
    appContentInFlight ||
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

  const submitSelfHostedApp = (): void => {
    const name = selfHostedName.trim()
    if (name === '' || selfHostedFile === null) return
    // The picked zip rides the merged create route as the `bundle` file part of
    // a multipart form (the server extracts + installs it).
    selfHostedMutation.mutate(
      { name, bundle: selfHostedFile },
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
            <Fragment key={app.id}>
              <div className={editorStyles['apps-editor__row']}>
                <div className={editorStyles['apps-editor__row-label']}>
                  <span className="text-body-2">{app.name}</span>
                  {app.subtitle !== undefined ? (
                    <span className={cn(editorStyles['apps-editor__row-sub'], 'text-body-3')}>
                      {app.subtitle}
                    </span>
                  ) : null}
                </div>
                {/*
                 * Enable toggle for every provenance (persisted via
                 * `PUT /home-screen`); a `Remove` button only when the row is
                 * `removable`, else a read-only provenance tag.
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
              {/*
               * An uploaded self-hosted app also gets an inline launch-path
               * editor: the stored SMART launcher path, editable in place (empty
               * reverts to root-serving). Only this variant carries `launchPath`.
               */}
              {app.provenance === 'self-hosted' && app.removable ? (
                <SelfHostedLaunchPathEditor app={app} />
              ) : null}
            </Fragment>
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
              submitSelfHostedApp()
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
