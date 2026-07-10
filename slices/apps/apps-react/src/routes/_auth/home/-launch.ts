import { AppsHttpApiClient } from 'apps-core/clients'
import { Effect } from 'effect'

import type { AppEntry } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'

/**
 * Inputs the {@link launchApp} dispatch needs to pick — and reach — its arm.
 *
 * - `apiBaseUrl`: the host API origin, set only on the Tauri webview whose page
 *   is served from the dev server / asset protocol (no `/apps` route). Its
 *   presence is *purely* the branch signal: set ⇒ the loopback (owner-gated)
 *   arm, which launches through the authed Effect client so the owner bearer
 *   rides along and the SPA stays mounted; unset ⇒ the web arm, a native
 *   `<a href="/apps/{id}">` the browser follows through the server's `302`. The
 *   loopback arm doesn't use `apiBaseUrl` as a fetch base — the typed client
 *   owns the host origin — so it stays in the context only as the arm selector.
 * - `runAuthed`: runs an Effect HttpApi client call with the owner bearer
 *   attached. The loopback launch is owner-gated server-side (it `401`s without
 *   a valid bearer), so this arm goes through `runAuthed` rather than a raw
 *   `fetch`. Mirrors how `useAppsListQuery` and the admin mutations call the
 *   client (see {@link AppsHttpApiClient}).
 */
export interface LaunchContext {
  readonly apiBaseUrl: string | undefined
  readonly runAuthed: RunAuthed
}

/**
 * The `href` for a home-screen tile's launch anchor, or `undefined` on Tauri.
 *
 * On **web** (`apiBaseUrl` unset) the tile is a real `<a href="/apps/{id}">`:
 * the page IS the API origin, so a page-relative path reaches the server's
 * launch route and the auth cookie rides the navigation. A plain click navigates
 * the current tab; a cmd/ctrl-click opens a new one — both native affordances a
 * form-submit or `fetch` can't preserve.
 *
 * On **Tauri** (`apiBaseUrl` set) there is deliberately no href: the loopback
 * arm launches through the authed client and the tile renders a plain button, so
 * a click never navigates the webview — it stays mounted while the host opens the
 * native popup. Returning `undefined` is what steers the tile to a `<button>`
 * rather than an anchor pointing at a route the Tauri page can't serve.
 */
const launchHref = (apiBaseUrl: string | undefined, id: string): string | undefined =>
  apiBaseUrl === undefined ? `/apps/${encodeURIComponent(id)}` : undefined

/**
 * Dispatch a launch of `app` against the arm selected by `ctx.apiBaseUrl`.
 *
 * - **Web / tunnel browser (apiBaseUrl unset)** — a no-op: the tile is a native
 *   `<a href>` (see {@link launchHref}) and the browser follows it, so there is
 *   nothing for JS to do. Kept as an explicit arm so a web tile that still wires
 *   a click to this never falls through to the authed loopback client.
 * - **Loopback / Tauri (apiBaseUrl set)** — `AppsHttpApiClient.LaunchApp`
 *   through `runAuthed`, so the owner bearer is attached. The loopback launch is
 *   owner-gated (the host `401`s an anonymous launch); the host's launch sink
 *   opens the native popup and `204`s, which the typed client resolves while the
 *   SPA stays mounted. A typed error (e.g. a `404` for a just-deleted app) is
 *   caught and logged rather than thrown to the click handler.
 */
const launchApp = async (ctx: LaunchContext, app: AppEntry): Promise<void> => {
  if (ctx.apiBaseUrl === undefined) return
  await postLaunch(ctx.runAuthed, app.id)
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

// `LaunchContext` stays an inline `export interface` above; the two functions are
// grouped here to satisfy `import/group-exports` (a single value-export decl).
export { launchApp, launchHref }
