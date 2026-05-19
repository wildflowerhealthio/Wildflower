import { AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await } from 'react-router'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'
import { useTunnelAdminEffect } from 'tunnel-react'

import { useRequestTunnel } from '../runtime/use-request-tunnel.ts'
import { useAppsEffect } from '../use-apps-effect.ts'
import { AppsEditor } from './apps-editor.tsx'
import appsHome from '../styles/apps-home.module.css'
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
      <Await resolve={combined}>
        {([apps, tunnel]: readonly [readonly AppEntry[], TunnelState]) => (
          <AppsHomeBody
            tunnel={tunnel}
            apps={apps}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
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
    const base = window.location.origin.replace(/\/$/, '')
    const target = `${base}/apps/${encodeURIComponent(app.id)}`
    if (!app.requiresTunnel || tunnel.running) {
      window.location.href = target
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
    const newOrigin = response.origin.replace(/\/$/, '')
    window.location.href = `${newOrigin}/apps/${encodeURIComponent(app.id)}`
  }

  return (
    <div className={pageLayout['page']}>
      <header className={pageLayout['page__header']}>
        <h1 className={cn(pageLayout['page__title'], 'text-heading-4')}>Apps</h1>
        <div className={appsHome['apps-home__header-actions']}>
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
        <div className={appsHome['apps-home__card-grid']}>
          {visible.map((app) => (
            <button
              key={app.id}
              className={appsHome['apps-home__card']}
              type="button"
              onClick={() => {
                void launch(app)
              }}
            >
              <span className="text-body-1">{app.name}</span>
              {app.subtitle !== undefined ? (
                <span className={cn(appsHome['apps-home__card-subtitle'], 'text-body-3')}>
                  {app.subtitle}
                </span>
              ) : null}
              <div className={appsHome['apps-home__card-footer']}>
                {app.requiresTunnel ? <span className="text-label-4">tunnel</span> : null}
                <span className="text-label-4">{app.kind}</span>
              </div>
            </button>
          ))}
        </div>
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
