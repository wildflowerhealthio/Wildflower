import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { useRef, useState, type JSX } from 'react'
import { AsyncErrorView, ItemList, PageHeader, type ItemListItem } from 'react-tundraish'

import { appsListQueryOptions, useAppsListQuery, type AppEntry } from '../../../queries.ts'
import type { RouterContext } from '../../../router-context.ts'
import { AppsEditor } from '../../../screens/apps-editor.tsx'
import { launchApp } from './-launch.ts'

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
  // Set only on the Tauri webview; its presence is the launch-arm signal —
  // see `launchApp` and `RouterContext.apiBaseUrl`.
  const apiBaseUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.apiBaseUrl,
  })

  const visible = apps.filter((app) => app.enabled)

  const launch = (app: AppEntry): void => {
    void launchApp({ apiBaseUrl, pageOrigin: window.location.origin, form: formRef.current }, app)
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
       * The launch vehicle for the web/tunnel-browser arm: a single hidden
       * form whose `action` is set per click so the browser follows the
       * server's 302. Tauri launches bypass it (they `fetch` so the 204
       * doesn't navigate the webview off the SPA) — see `launchApp`.
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
