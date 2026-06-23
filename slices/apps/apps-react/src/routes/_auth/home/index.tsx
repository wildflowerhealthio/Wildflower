import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { stripTrailingSlash } from 'kitchen-sink'
import { useRef, useState, type JSX } from 'react'
import { AsyncErrorView, ItemList, PageHeader, type ItemListItem } from 'react-tundraish'

import { appsListQueryOptions, useAppsListQuery, type AppEntry } from '../../../queries.ts'
import type { RouterContext } from '../../../router-context.ts'
import { AppsEditor } from '../../../screens/apps-editor.tsx'

/**
 * Owner-facing apps landing. The route `loader` warms the apps-list query
 * against the shared `QueryClient`; by the time the component renders,
 * `useAppsListQuery` resolves synchronously from cache. The router's own
 * pending UI covers the load window — no inline `<Suspense>` fallback, no
 * `<CatchBoundary>`; read failures propagate to the route's `errorComponent`.
 * Mutations triggered inside `<AppsEditor>` auto-invalidate the list query.
 */
const AppsHomeScreen = (): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  return <AppsHomeBody apps={apps} />
}

interface AppsHomeBodyProps {
  readonly apps: readonly AppEntry[]
}

const AppsHomeBody = ({ apps }: AppsHomeBodyProps): JSX.Element => {
  const [editorOpen, setEditorOpen] = useState(false)
  const formRef = useRef<HTMLFormElement | null>(null)
  // The launch base: the host API origin for entries whose page isn't served
  // by the API (the Tauri webview, via `apiBaseUrl`), else the page origin.
  // The Tauri webview loads from the Vite dev server / asset protocol, which
  // has no `/apps` route — without this branch a same-origin POST would 404
  // there instead of reaching the embedded API server. The server owns
  // origin/tunnel resolution from there.
  const apiBaseUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.apiBaseUrl,
  })
  const launchBase = stripTrailingSlash(apiBaseUrl ?? window.location.origin)

  const visible = apps.filter((app) => app.enabled)

  /**
   * Launch an app via `POST ${launchBase}/apps/{id}`.
   *
   * Branched on `apiBaseUrl` to match each entry's launch contract:
   *
   * - **Tauri (`apiBaseUrl` set)**: fetch — the host's launch sink already
   *   owns the side-effect (it opens a native popup), so the server `204`s and
   *   the SPA stays mounted. A form submit was navigating the webview to the
   *   `204` URL despite the empty body, leaving a blank page behind the popup;
   *   `fetch` doesn't navigate, so the SPA stays put. Fire-and-forget — a
   *   failure to reach the sink is logged but doesn't surface (matches the
   *   prior bridge round-trip's fire-and-forget shape).
   * - **Web / tunnel browser (`apiBaseUrl` unset)**: form submit — the page is
   *   the API origin (or a tunnel-forwarded view of it), so the server `302`s
   *   and the browser follows the redirect to the resolved launch URL.
   */
  const launch = (app: AppEntry): void => {
    const url = `${launchBase}/apps/${encodeURIComponent(app.id)}`
    if (apiBaseUrl !== undefined) {
      void fetch(url, { method: 'POST' }).catch((error: unknown) => {
        // oxlint-disable-next-line no-console
        console.error('[apps] launch fetch failed', error)
      })
      return
    }
    const form = formRef.current
    if (form === null) return
    form.action = url
    form.submit()
  }

  return (
    <>
      <PageHeader
        title="Apps"
        actions={
          <button
            type="button"
            className="button-2 outline"
            onClick={() => {
              setEditorOpen(true)
            }}
          >
            Manage
          </button>
        }
      />
      {visible.length === 0 ? (
        <p className="text-body-2">No apps enabled. Tap Manage to turn some on.</p>
      ) : (
        <ItemList
          items={visible.map<ItemListItem>((app) => ({
            id: app.id,
            title: app.name,
            subtitle: app.subtitle,
            badge: app.requiresTunnel ? 'tunnel' : undefined,
            onClick: () => {
              launch(app)
            },
          }))}
        />
      )}
      {/*
       * The launch vehicle for web/tunnel browser launches (the page IS the
       * API origin or a forwarded view of it): a single hidden form whose
       * `action` is set per click; the browser follows the server's 302 to
       * the resolved launch URL. Tauri launches bypass this form entirely
       * and go through `fetch` so the 204 doesn't navigate the webview off
       * the SPA. No fields — the app id rides in the path.
       */}
      <form ref={formRef} method="post" hidden />
      <AppsEditor
        open={editorOpen}
        apps={apps}
        onClose={() => {
          setEditorOpen(false)
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/_auth/home/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appsListQueryOptions(context.runAuthed)),
  component: AppsHomeScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})
