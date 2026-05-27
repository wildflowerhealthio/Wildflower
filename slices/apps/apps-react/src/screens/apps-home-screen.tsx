import { AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { stripTrailingSlash } from 'kitchen-sink'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Awaited, ItemList, type ItemListItem } from 'react-tundraish'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'
import { useTunnelAdminEffect } from 'tunnel-react'

import { useAppsEffect } from '../apps-client.tsx'
import { useRequestTunnel } from '../runtime/use-request-tunnel.ts'
import { AppsEditor } from './apps-editor.tsx'
import pageLayout from '../styles/page.module.css'

type AppEntry = Schema.Schema.Type<typeof Schemas.AppEntrySchema>
type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

const AppsHomeScreen = (): JSX.Element => {
  const [refreshKey, setRefreshKey] = useState(0)

  // Build each Effect inside `useMemo([refreshKey])` so a refresh
  // produces fresh Effect references and the underlying `useEffectTs`
  // reaches its new-input branch. `useAppsEffect` and
  // `useTunnelAdminEffect` each provide their own client layer; we run
  // them as two Suspense-friendly promises and `Promise.all` the
  // results inside `<Await>` to render a single body.
  const appsEffect = useMemo(
    () => Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )
  const tunnelEffect = useMemo(
    () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const appsPromise = useAppsEffect(appsEffect)
  const tunnelPromise = useTunnelAdminEffect(tunnelEffect)

  const combined = useMemo(
    () => Promise.all([appsPromise, tunnelPromise] as const),
    [appsPromise, tunnelPromise]
  )

  return (
    <Suspense fallback={<p className="text-body-2">Loading apps…</p>}>
      <Awaited promise={combined} resetKey={refreshKey}>
        {([apps, tunnel]: readonly [readonly AppEntry[], TunnelState]) => (
          <AppsHomeBody
            tunnel={tunnel}
            apps={apps}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

interface AppsHomeBodyProps {
  readonly tunnel: TunnelState
  readonly apps: readonly AppEntry[]
  readonly onChanged: () => void
}

const AppsHomeBody = ({ tunnel, apps, onChanged }: AppsHomeBodyProps): JSX.Element => {
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
    // Embedding Expo host? Ask it to start its tunnel via the bridge,
    // then jump to the newly-tunneled origin. Standalone-web users
    // (no host) get the timeout fall-back from `useRequestTunnel`.
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
        onChanged={onChanged}
      />
    </div>
  )
}

export { AppsHomeScreen }
