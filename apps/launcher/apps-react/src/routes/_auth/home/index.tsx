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
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import {
  AsyncErrorView,
  ErrorBanner,
  PageHeader,
  SettingsLink,
} from '@wildflowerhealthio/react-tundraish'
import { useEffect, useState, type JSX } from 'react'

import { Either } from 'effect'
import {
  appsListQueryOptions,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
  type AppRegistration,
} from '../../../queries.ts'
import type { RouterContext } from '../../../router-context.ts'
import { launchBannerError } from './-launch-error.ts'
import { launchApp, type LaunchContext } from './-launch.ts'
import { reorderApps } from './-reorder.ts'
import { SortableAppTile, type LaunchPlace } from './-tiles.tsx'
import tileStyles from '../../../styles/app-tiles.module.css'
import homeStyles from '../../../styles/apps-home.module.css'

export interface HomeSearch {
  /** The base64 launch-error body (see `-launch-error.ts`) — an opaque string the
   * banner decodes; both arms set it, so it's kept verbatim. */
  readonly launchError?: string
  /**
   * Present (`?edit=true`) while the home screen is being arranged: tiles drag
   * to reorder and carry a hide badge instead of launching. Settings' "Arrange
   * home screen" row links here with it (`settings-fragments.ts`); the header's
   * Done drops it.
   */
  readonly edit?: true
}

/** Validate `/home`'s search: keep a string `launchError` param (the base64 error
 * body both arms set — see the Rust launch middleware and `-launch.ts`) and an
 * `edit` param of `true` (the router parses `?edit=true` to the boolean), drop
 * anything else. */
const validateHomeSearch = (search: Record<string, unknown>): HomeSearch => {
  const launchError = search['launchError']
  return {
    ...(typeof launchError === 'string' ? { launchError } : {}),
    ...(search['edit'] === true ? { edit: true } : {}),
  }
}

/**
 * Owner-facing apps landing. The route `loader` warms the apps-list query
 * against the shared `QueryClient`; by the time the component renders,
 * `useAppsListQuery` resolves synchronously from cache. The router's own
 * pending UI covers the load window — no inline `<Suspense>` fallback, no
 * `<CatchBoundary>`; read failures propagate to the route's `errorComponent`.
 * The home-screen `PUT`s (reorder + hide) auto-invalidate the list query;
 * catalogue management (add / remove / configure / re-enable) lives under
 * `/settings/apps`.
 *
 * Both search params live in the URL, not in component state, so each change
 * to one keeps the other: a launch outcome arriving while the screen is being
 * arranged leaves `?edit` alone, and Done leaves a launch banner up.
 */
const AppsHomeScreen = (): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  const { launchError, edit } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AppsHomeBody
      apps={apps}
      launchError={launchError}
      editing={edit === true}
      onDoneEditing={() => {
        // Replace rather than push: Back from the home screen then returns to
        // wherever arranging began (Settings), not into arranging again.
        void navigate({ search: (previous) => ({ ...previous, edit: undefined }), replace: true })
      }}
      onLaunchResult={(launchResult) => {
        // Reflect the outcome into the `?launchError` param: a failure shows the
        // banner; a later success clears a stale one.
        Either.match(launchResult, {
          onLeft: (errorBody) => {
            void navigate({ search: (previous) => ({ ...previous, launchError: errorBody }) })
          },
          onRight: () => {
            if (launchError !== undefined) {
              void navigate({ search: (previous) => ({ ...previous, launchError: undefined }) })
            }
          },
        })
      }}
    />
  )
}

interface AppsHomeBodyProps {
  readonly apps: readonly AppRegistration[]
  /** The base64 launch-error body from the `?launchError` search param, if any. */
  readonly launchError?: string
  /**
   * Whether the home screen is being arranged (the `?edit` search param). Off
   * by default: tiles launch on click and can't be dragged. On, tiles drag to
   * reorder and each carries a "Hide" badge, and the header's Settings gear
   * gives way to Done.
   */
  readonly editing?: boolean
  /** Called when Done is pressed, so the route can drop the `?edit` param. */
  readonly onDoneEditing?: () => void
  /**
   * Called with the launch outcome — the encoded `?launchError` body on failure,
   * `right` on success — so the route can reflect it into the search param.
   */
  readonly onLaunchResult?: (result: Either.Either<void, string>) => void
}

/** Move this tab to the launch URL a launch answered with. */
const navigateToLaunch = (url: string): void => {
  window.location.assign(url)
}

/**
 * Launch into a new tab. The tab is opened now, inside the click, because a
 * popup blocker only lets a page open one from a user gesture — not after the
 * launch request resolves. It then follows the app's URL, or closes again when
 * the launch failed. `opener` is dropped
 * before the app loads so it can't reach back into this page.
 */
const launchInNewTab = (
  runAuthed: LaunchContext['runAuthed'],
  appId: string
): ReturnType<typeof launchApp> => {
  const tab = window.open('', '_blank')
  return launchApp(
    {
      runAuthed,
      navigate: (url) => {
        if (tab === null) {
          window.open(url, '_blank', 'noopener,noreferrer')
          return
        }
        tab.opener = null
        tab.location.replace(url)
      },
    },
    appId
  ).then((result) => {
    if (Either.isLeft(result)) tab?.close()
    return result
  })
}

const AppsHomeBody = ({
  apps,
  launchError,
  editing = false,
  onDoneEditing,
  onLaunchResult,
}: AppsHomeBodyProps): JSX.Element => {
  const homeScreenMutation = useReplaceHomeScreenMutation()
  // The launch rides `runAuthed` so the owner bearer is attached (the host 401s
  // an anonymous launch) — same runner the list read uses.
  const runAuthed = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runAuthed,
  })

  // Hold the **full** registry order in state; the home screen renders only the
  // enabled subset (`visible`, below). A drag moves a tile within the full list
  // and PUTs the whole thing to `/home-screen`, so disabled apps keep their
  // slots. `order` is purely the local UI state a server refetch can't own: the
  // drag *sequence* and the optimistic `onHomescreen` flags (a reorder/hide that
  // hasn't round-tripped yet). Tile *content* — name / subtitle — is
  // never read off `order`; it's looked up live from `apps` at render (see
  // `visible`), so a background refetch that changes only a tile's name/subtitle
  // shows through even though the resync key below hasn't changed.
  // Re-seed whenever the server list changes (order *or* enabled) — the
  // home-screen PUT invalidates the list query — so an enable/disable made in
  // the editor is reflected here too.
  const [order, setOrder] = useState<readonly AppRegistration[]>(apps)
  useEffect(() => {
    setOrder(apps)
    // `apps` is a fresh array each render; key the resync on the stable id +
    // onHomescreen sequence so it runs only when the server list actually
    // changes, not on every render. Content-only changes (name/subtitle)
    // deliberately don't re-seed — they'd clobber an in-flight optimistic
    // reorder/hide — and don't need to: `visible` reads content from `apps`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [apps.map((app) => `${app.id}:${app.onHomescreen ? 1 : 0}`).join(' ')])

  // The enabled subset to render, in `order`'s sequence but with each tile's
  // content taken from the live `apps` row so a background refetch's name/
  // subtitle edits show without waiting on a resync. `order` still owns the
  // optimistic `onHomescreen` flag (a just-hidden tile must drop out before the
  // PUT lands), so filter on the order entry and only the *content* comes from
  // `apps`; fall back to the order entry if an id isn't in `apps` yet (it always
  // should be — `order` is only ever seeded/reordered from `apps`).
  const appsById = new Map(apps.map((app) => [app.id, app]))
  const visible = order
    .filter((entry) => entry.onHomescreen)
    .map((entry) => appsById.get(entry.id) ?? entry)

  const sensors = useSensors(
    // A small activation distance lets a plain click reach the tile's launch
    // button instead of being swallowed as a (zero-distance) drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // The outcome (an encoded failure body, or `right` on success) is handed up
  // so the route reflects it into the `?launchError` banner. A launch answers a
  // URL, which moves this tab — or the new one (see `launchApp`).
  const launch = (app: AppRegistration, place: LaunchPlace): void => {
    const launching =
      place === 'newTab'
        ? launchInNewTab(runAuthed, app.id)
        : launchApp({ runAuthed, navigate: navigateToLaunch }, app.id)
    void launching.then((kind) => {
      onLaunchResult?.(kind)
    })
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null) return
    // Don't start a second home-screen write while one is in flight: both this
    // and `disable` are optimistic with rollback to a captured `previous`, so
    // an overlapping PUT could revert newer local state on failure.
    if (homeScreenMutation.isPending) return
    // Reorder within the full list (disabled apps keep their slots), then PUT the
    // whole ordered set — the server's atomic renumber is the single writer (see
    // the Rust `replace_home_screen`).
    const next = reorderApps(order, String(active.id), String(over.id))
    if (next === null) return
    // Optimistic reorder. On failure the PUT doesn't invalidate the list (so the
    // resync effect won't re-seed `order`), which would leave the tiles diverged
    // from the server — so roll `order` back to its pre-drag value and surface
    // the error in the banner below.
    const previous = order
    setOrder(next)
    homeScreenMutation.mutate(
      next.map((app) => ({ id: app.id, onHomescreen: app.onHomescreen })),
      {
        onError: () => {
          setOrder(previous)
        },
      }
    )
  }

  // Hide an app from the home screen: flip its `onHomescreen` to false and PUT
  // the whole ordered list (hidden apps keep their slots). Optimistic + rollback,
  // mirroring `onDragEnd` — on failure the PUT doesn't invalidate the list, so
  // roll `order` back and surface the error banner. Re-showing lives in
  // `/settings/apps`.
  const disable = (app: AppRegistration): void => {
    // Skip while a home-screen write is already in flight — see `onDragEnd`.
    if (homeScreenMutation.isPending) return
    const previous = order
    const next = order.map((entry) =>
      entry.id === app.id ? { ...entry, onHomescreen: false } : entry
    )
    setOrder(next)
    homeScreenMutation.mutate(
      next.map((entry) => ({ id: entry.id, onHomescreen: entry.onHomescreen })),
      {
        onError: () => {
          setOrder(previous)
        },
      }
    )
  }

  return (
    <>
      <PageHeader
        title="Apps"
        actions={
          editing ? (
            <button
              type="button"
              className={cn('button', 'button-2', 'ghost', homeStyles['apps-home__done'])}
              onClick={() => {
                onDoneEditing?.()
              }}
            >
              Done
            </button>
          ) : (
            <SettingsLink href="/settings" label="Settings" />
          )
        }
      />
      {/* A launch that failed (the browser arm was redirected here with
          `?launchError`; the Tauri arm set it via `onLaunchResult`). The decoded
          body routes through the same renderer, so a `403` names the missing scopes. */}
      <ErrorBanner error={launchBannerError(launchError)} />
      {/* A failed home-screen reorder/hide — a `403` shows the permission surface. */}
      <ErrorBanner error={homeScreenMutation.error} />
      {visible.length === 0 ? (
        <p className="text-body-2">No apps on your home screen. Add or enable apps in Settings.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={visible.map((app) => app.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className={tileStyles['app-tiles']}>
              {visible.map((app) => (
                <SortableAppTile
                  key={app.id}
                  app={app}
                  editing={editing}
                  onLaunch={launch}
                  onDisable={disable}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </>
  )
}

const Route = createFileRoute('/_auth/home/')({
  validateSearch: validateHomeSearch,
  loader: ({ context }) =>
    context.queryClient.query({ ...appsListQueryOptions(context.runAuthed), staleTime: 'static' }),
  component: AppsHomeScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

// `AppsHomeBody` and `validateHomeSearch` are exported for unit tests (the body
// renders independently of the route loader); grouped with `Route` into one
// declaration for `import/group-exports`.
export { AppsHomeBody, Route, validateHomeSearch }
