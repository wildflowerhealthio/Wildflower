import { AppsHttpApiClient } from 'apps-core/clients'
import { Effect } from 'effect'
import { stripTrailingSlash } from 'kitchen-sink'

import type { AppEntry } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'

/**
 * Inputs the {@link launchApp} dispatch needs to pick — and reach — its arm.
 *
 * - `apiBaseUrl`: the host API origin, set only on the Tauri webview whose
 *   page is served from the dev server / asset protocol (no `/apps` route).
 *   Its presence is *purely* the branch signal here: set ⇒ the loopback
 *   (owner-gated) arm, which launches through the authed Effect client so the
 *   owner bearer rides along; unset ⇒ the forwarded (web) arm, a form submit
 *   the browser follows through the server's `302`. The loopback arm no longer
 *   uses `apiBaseUrl` as a fetch base — the typed client owns the host origin —
 *   so it stays in the context only as the arm selector.
 * - `runAuthed`: runs an Effect HttpApi client call with the owner bearer
 *   attached. The loopback launch is owner-gated server-side (it `401`s without
 *   a valid bearer), so this arm goes through `runAuthed` rather than a raw
 *   `fetch`. Mirrors how `useAppsListQuery` and the admin mutations call the
 *   client (see {@link AppsHttpApiClient}).
 * - `pageOrigin`: the SPA's page origin, used as the launch base in the
 *   form-submit arm. Passed in (rather than read off `window`) so that arm
 *   stays a pure function — tests don't need to fake `window.location`.
 * - `form`: the hidden form whose `action` is set per click on the form-submit
 *   arm. `null` (the ref hasn't attached yet, or the component unmounted) is
 *   a no-op rather than a throw.
 */
export interface LaunchContext {
  readonly apiBaseUrl: string | undefined
  readonly runAuthed: RunAuthed
  readonly pageOrigin: string
  readonly form: HTMLFormElement | null
}

/**
 * Dispatch a launch of `app` against the arm selected by `ctx.apiBaseUrl`.
 *
 * Two arms:
 *
 * - **Loopback / Tauri (apiBaseUrl set)** — `AppsHttpApiClient.LaunchApp`
 *   through `runAuthed`, so the owner bearer is attached. The loopback launch
 *   is owner-gated (the host `401`s an anonymous launch); the host's launch
 *   sink opens the native popup and `204`s, which the typed client resolves
 *   while the SPA stays mounted. A typed error (e.g. a `404` for a
 *   just-deleted app) is caught and logged rather than thrown to the click
 *   handler.
 * - **Web / tunnel browser (apiBaseUrl unset)** — `form.submit()` to
 *   `${pageOrigin}/apps/{id}`. This arm rides the front trust boundary (no
 *   bearer): the page IS the API origin, the server `302`s, and the browser
 *   follows the redirect to the resolved launch URL. A missing `form` ref is a
 *   no-op.
 */
export const launchApp = async (ctx: LaunchContext, app: AppEntry): Promise<void> => {
  if (ctx.apiBaseUrl === undefined) {
    const launchBase = stripTrailingSlash(ctx.pageOrigin)
    submitForm(ctx.form, `${launchBase}/apps/${encodeURIComponent(app.id)}`)
    return
  }
  await postLaunch(ctx.runAuthed, app.id)
}

const submitForm = (form: HTMLFormElement | null, url: string): void => {
  if (form === null) return
  form.action = url
  form.submit()
}

const postLaunch = async (runAuthed: RunAuthed, id: string): Promise<void> => {
  try {
    await runAuthed(Effect.flatMap(AppsHttpApiClient, (c) => c.apps.LaunchApp({ path: { id } })))
  } catch (error: unknown) {
    // The host's launch sink already opened (or failed to open) the popup;
    // a typed failure here (e.g. a `404` for a just-deleted/disabled app)
    // surfaces as a rejected `runAuthed`. Log it rather than throw into the
    // click handler — the SPA stays mounted either way.
    // oxlint-disable-next-line no-console
    console.error('[apps] launch failed', error)
  }
}
