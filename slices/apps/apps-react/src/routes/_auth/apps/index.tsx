import { CatchBoundary, createFileRoute } from '@tanstack/react-router'
import { stripTrailingSlash } from 'kitchen-sink'
import { Suspense, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, ItemList, type ItemListItem } from 'react-tundraish'
import { useTunnelStateQuery, type RunAuthed, type TunnelState } from 'tunnel-react'

import { useAppsListQuery, type AppEntry } from '../../../queries.ts'
import type { AppsRouterContext } from '../../../router-context.ts'
import { useRequestTunnel } from '../../../runtime/use-request-tunnel.ts'
import { AppsEditor } from '../../../screens/apps-editor.tsx'
import pageLayout from '../../../styles/page.module.css'

/**
 * Read the authed runner off this route's context. `select` is annotated
 * with the structural {@link AppsRouterContext} so the result is a typed
 * {@link RunAuthed} — NOT `any`. (Standalone, the slice registers no
 * `Router`, so an un-`select`ed `Route.useRouteContext()` widens to
 * `any`; the annotated `select` keeps it honest without an unsafe cast.)
 */
const useAppsRunAuthed = (): RunAuthed =>
  Route.useRouteContext({ select: (context: AppsRouterContext) => context.runAuthed })

const AppsHomeContent = (): JSX.Element => {
  // Two Suspense-backed queries side-by-side. TanStack Query runs them
  // in parallel and suspends until both resolve, reading from the shared
  // in-memory cache (warmed by route preloading) so a revisit within the
  // session renders instantly while any refetch goes out in the
  // background.
  //
  // The tunnel read crosses a slice boundary: `useTunnelStateQuery` now
  // takes the authed `runAuthed` runner explicitly (tunnel-react dropped
  // its `<TunnelClientProvider>` DI), so we pull `runAuthed` off this
  // route's context and hand it over.
  const runAuthed = useAppsRunAuthed()
  const { data: apps } = useAppsListQuery()
  const { data: tunnel } = useTunnelStateQuery(runAuthed)
  return <AppsHomeBody apps={apps} tunnel={tunnel} />
}

/**
 * Owner-facing apps landing. Reads the apps list and the tunnel state
 * via TanStack Query (`useAppsListQuery` + `useTunnelStateQuery`), so
 * the screen renders from localStorage-persisted cache on mount and a
 * background refetch swaps in fresh data once both queries return.
 * Mutations triggered inside `<AppsEditor>` auto-invalidate the list
 * query — no `onChanged` prop drilling required.
 */
function AppsHomeScreen(): JSX.Element {
  return (
    <CatchBoundary
      getResetKey={() => 'apps-home'}
      errorComponent={({ error }) => <AsyncErrorView error={error} title="Apps" />}
    >
      <Suspense fallback={<p className="text-body-2">Loading apps…</p>}>
        <AppsHomeContent />
      </Suspense>
    </CatchBoundary>
  )
}

interface AppsHomeBodyProps {
  readonly tunnel: TunnelState
  readonly apps: readonly AppEntry[]
}

function AppsHomeBody({ tunnel, apps }: AppsHomeBodyProps): JSX.Element {
  const [editorOpen, setEditorOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestTunnel = useRequestTunnel()

  const visible = apps.filter((app) => app.enabled)

  const launch = async (app: AppEntry): Promise<void> => {
    setError(null)
    // LaunchApp is GET /apps/:id which returns a 302 redirect; we set
    // window.location so the browser follows the redirect chain (and any
    // tunnel-side origin swap) just as a normal app-shell click would.
    //
    // Origin policy:
    //  - Non-tunnel apps always go through `window.location.origin`,
    //    which the embedded shell pins to the loopback origin. That
    //    keeps the redirect off the public tunnel even when one is up
    //    (avoiding localtunnel's 511 captive-portal interstitial).
    //  - Tunnel apps explicitly target `tunnel.servedOrigin` — the
    //    server-resolved public URL — when the tunnel is live, or
    //    request one via the bridge if it isn't yet.
    const launchPath = `/apps/${encodeURIComponent(app.id)}`
    if (!app.requiresTunnel) {
      window.location.href = `${stripTrailingSlash(window.location.origin)}${launchPath}`
      return
    }
    if (tunnel.running) {
      window.location.href = `${stripTrailingSlash(tunnel.servedOrigin)}${launchPath}`
      return
    }
    const response = await requestTunnel()
    if ('error' in response) {
      setError(`Tunnel failed: ${response.error}`)
      return
    }
    window.location.href = `${stripTrailingSlash(response.origin)}${launchPath}`
  }

  return (
    <div className={pageLayout['page']}>
      <header className={pageLayout['page__header']}>
        <h1 className={cn(pageLayout['page__title'], 'text-heading-4')}>Apps</h1>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          {tunnel.running ? <span className="text-label-4">tunnel</span> : null}
          <button
            type="button"
            className="button-3 outline"
            onClick={() => {
              setEditorOpen(true)
            }}
          >
            Manage
          </button>
        </div>
      </header>
      {error !== null ? (
        <p className={cn(pageLayout['page__error'], 'text-body-3')} role="alert">
          {error}
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="text-body-2">No apps enabled. Tap Manage to turn some on.</p>
      ) : (
        <ItemList
          items={visible.map<ItemListItem>((app) => ({
            id: app.id,
            title: app.name,
            subtitle: app.subtitle,
            badge: app.requiresTunnel ? 'tunnel' : undefined,
            actions: <span className="text-label-4">{app.kind}</span>,
            onClick: () => {
              void launch(app)
            },
          }))}
        />
      )}
      <AppsEditor
        open={editorOpen}
        apps={apps}
        onClose={() => {
          setEditorOpen(false)
        }}
      />
    </div>
  )
}

export const Route = createFileRoute('/_auth/apps/')({
  component: AppsHomeScreen,
})
