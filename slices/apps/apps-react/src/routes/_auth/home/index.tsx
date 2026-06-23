import { createFileRoute } from '@tanstack/react-router'
import { stripTrailingSlash } from 'kitchen-sink'
import { useRef, useState, type JSX } from 'react'
import { AsyncErrorView, ItemList, PageHeader, type ItemListItem } from 'react-tundraish'

import { appsListQueryOptions, useAppsListQuery, type AppEntry } from '../../../queries.ts'
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
  // Launch posts to the page origin: every entry today serves the SPA from the
  // same origin as the API (the Tauri webview loads from the host's loopback
  // server, web from its own server), so a same-origin POST reaches the launch
  // endpoint. The server owns origin/tunnel resolution from there.
  const launchBase = stripTrailingSlash(window.location.origin)

  const visible = apps.filter((app) => app.enabled)

  /**
   * Launch an app by submitting a real `POST` to `${launchBase}/apps/{id}`.
   *
   * A form submit (not `fetch`) so the browser handles the server's response
   * as a navigation: on web the server `302`s and the page lands at the app;
   * on the Tauri host the server `204`s (its launch sink already opened a
   * native popup) and the browser stays on the SPA — no client branching on
   * Tauri-vs-web. The form's `action` is set per click, then submitted.
   */
  const launch = (app: AppEntry): void => {
    const form = formRef.current
    if (form === null) return
    form.action = `${launchBase}/apps/${encodeURIComponent(app.id)}`
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
       * The launch vehicle: a single hidden form whose `action` is set per
       * click. `method="post"` so the server sees the launch; the browser
       * follows the 302 (web) or stays put on the 204 (Tauri). No fields — the
       * app id rides in the path.
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
