import { stripTrailingSlash } from 'kitchen-sink'

import type { AppEntry } from '../../../queries.ts'

/**
 * Inputs the [`launchApp`] dispatch needs to pick — and reach — its arm.
 *
 * - `apiBaseUrl`: the host API origin, set only on the Tauri webview whose
 *   page is served from the dev server / asset protocol (no `/apps` route).
 *   Its presence is *also* the branch signal: set ⇒ fetch (the host sink
 *   owns the side-effect, server `204`s); unset ⇒ form submit (the page IS
 *   the API origin and the server `302`s for the browser to follow).
 * - `pageOrigin`: the SPA's page origin, used as the launch base in the
 *   form-submit arm. Passed in (rather than read off `window`) so the helper
 *   stays a pure function — tests don't need to fake `window.location`.
 * - `form`: the hidden form whose `action` is set per click on the form-submit
 *   arm. `null` (the ref hasn't attached yet, or the component unmounted) is
 *   a no-op rather than a throw.
 */
export interface LaunchContext {
  readonly apiBaseUrl: string | undefined
  readonly pageOrigin: string
  readonly form: HTMLFormElement | null
}

/**
 * Dispatch a launch of `app` against the launch base derived from `ctx`.
 *
 * Two arms, picked by `ctx.apiBaseUrl`:
 *
 * - **Tauri (apiBaseUrl set)** — `POST ${apiBaseUrl}/apps/{id}` via `fetch` with
 *   `redirect: 'manual'`. The host's launch sink already opens the native
 *   popup, so the server `204`s and the SPA stays mounted. `redirect: 'manual'`
 *   makes a stray `302` visible (`response.type === 'opaqueredirect'`,
 *   `response.ok === false`) rather than silently followed and discarded; an
 *   unexpected status is logged instead of being a quiet no-op (e.g. a launch
 *   of a just-deleted/disabled app would 404 — `fetch` would resolve the
 *   response, not reject, so a `.catch`-only path would never see it).
 * - **Web / tunnel browser (apiBaseUrl unset)** — `form.submit()` to
 *   `${pageOrigin}/apps/{id}`. The page IS the API origin, the server `302`s,
 *   and the browser follows the redirect to the resolved launch URL. A
 *   missing `form` ref is a no-op.
 *
 * Returned promise resolves once the dispatch is complete — tests can await
 * it; the click handler treats it as fire-and-forget.
 */
export const launchApp = async (ctx: LaunchContext, app: AppEntry): Promise<void> => {
  const launchBase = stripTrailingSlash(ctx.apiBaseUrl ?? ctx.pageOrigin)
  const url = `${launchBase}/apps/${encodeURIComponent(app.id)}`
  if (ctx.apiBaseUrl === undefined) {
    submitForm(ctx.form, url)
    return
  }
  await postLaunch(url)
}

const submitForm = (form: HTMLFormElement | null, url: string): void => {
  if (form === null) return
  form.action = url
  form.submit()
}

const postLaunch = async (url: string): Promise<void> => {
  try {
    // `redirect: 'manual'` so a server-side fallback to 302 (sink unexpectedly
    // `None`, or the request read as forwarded) returns an opaque-redirect
    // response we can see, rather than being transparently followed and the
    // result discarded — fetch's default `follow` would swallow it silently.
    const response = await fetch(url, { method: 'POST', redirect: 'manual' })
    if (!response.ok) {
      // 204 is the only expected status on the Tauri arm (sink owns the
      // popup). Anything else — a real 4xx/5xx, or `opaqueredirect` from a
      // stray 302 — means the popup didn't open, so log instead of silently
      // swallowing.
      // oxlint-disable-next-line no-console
      console.error(
        '[apps] launch fetch returned unexpected status',
        response.status,
        response.type
      )
    }
  } catch (error: unknown) {
    // oxlint-disable-next-line no-console
    console.error('[apps] launch fetch failed', error)
  }
}
