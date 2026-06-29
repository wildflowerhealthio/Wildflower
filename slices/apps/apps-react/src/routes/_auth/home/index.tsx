import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { useEffect, useRef, useState, type JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import {
  appsListQueryOptions,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
  type AppEntry,
} from '../../../queries.ts'
import type { RouterContext } from '../../../router-context.ts'
import { AppsEditor } from '../../../screens/apps-editor.tsx'
import { launchApp } from './-launch.ts'
import { reorderApps } from './-reorder.ts'
import { SortableAppTile } from './-tiles.tsx'
import tileStyles from '../../../styles/app-tiles.module.css'

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
  const homeScreenMutation = useReplaceHomeScreenMutation()
  // Set only on the Tauri webview; its presence is the launch-arm signal —
  // see `launchApp` and `RouterContext.apiBaseUrl`.
  const apiBaseUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.apiBaseUrl,
  })
  // The loopback launch arm rides `runAuthed` so the owner bearer is attached
  // (the host 401s an anonymous launch) — same runner the list read uses.
  const runAuthed = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runAuthed,
  })

  // Hold the **full** registry order in state; the home screen renders only the
  // enabled subset (`visible`, below). A drag moves a tile within the full list
  // and PUTs the whole thing to `/home-screen`, so disabled apps keep their
  // slots. Re-seed whenever the server list changes (order *or* enabled) — the
  // home-screen PUT invalidates the list query — so an enable/disable made in
  // the editor is reflected here too.
  const [order, setOrder] = useState<readonly AppEntry[]>(apps)
  useEffect(() => {
    setOrder(apps)
    // `apps` is a fresh array each render; key the resync on the stable id +
    // enabled sequence so it runs only when the server list actually changes,
    // not on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [apps.map((app) => `${app.id}:${app.enabled ? 1 : 0}`).join(' ')])

  const visible = order.filter((app) => app.enabled)

  const sensors = useSensors(
    // A small activation distance lets a plain click reach the tile's launch
    // button instead of being swallowed as a (zero-distance) drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const launch = (app: AppEntry): void => {
    void launchApp(
      { apiBaseUrl, runAuthed, pageOrigin: window.location.origin, form: formRef.current },
      app
    )
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null) return
    // Reorder within the full list (disabled apps keep their slots), then PUT the
    // whole ordered set — the server's atomic renumber is the single writer (see
    // the Rust `replace_home_screen`).
    const next = reorderApps(order, String(active.id), String(over.id))
    if (next === null) return
    setOrder(next)
    homeScreenMutation.mutate(next.map((app) => ({ id: app.id, enabled: app.enabled })))
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={visible.map((app) => app.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className={tileStyles['app-tiles']}>
              {visible.map((app) => (
                <SortableAppTile key={app.id} app={app} onLaunch={launch} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {/*
       * The launch vehicle for the web/tunnel-browser arm: a single hidden
       * form whose `action` is set per click so the browser follows the
       * server's 302. The loopback (Tauri) arm bypasses it entirely — it
       * launches through the authed Effect client so the owner bearer rides
       * along and the host's 204 never navigates the webview — see `launchApp`.
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
