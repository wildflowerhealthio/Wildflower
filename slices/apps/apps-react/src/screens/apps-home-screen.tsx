import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas, Server } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await } from 'react-router'

import { useRequestTunnel } from '../runtime/use-request-tunnel.ts'
import { useAppsAdminEffect, useAppsEffect } from '../use-apps-effect.ts'
import { AppsEditor } from './apps-editor.tsx'
import appsHome from '../styles/apps-home.module.css'
import pageLayout from '../styles/page.module.css'

type AppEntry = Schema.Schema.Type<typeof Schemas.AppEntrySchema>
type ServerState = Schema.Schema.Type<typeof Server.ServerStateSchema>

const AppsHomeScreen = (): JSX.Element => {
  const [refreshKey, setRefreshKey] = useState(0)

  // Group A3 option B: build each Effect inside `useMemo([refreshKey])`
  // so a refresh produces fresh Effect references and the underlying
  // `useEffectTs` reaches its new-input branch. `useAppsEffect` and
  // `useAppsAdminEffect` each provide their own client layer; we run
  // them as two Suspense-friendly promises and `Promise.all` the
  // results inside `<Await>` to render a single body.
  const appsEffect = useMemo(
    () => Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )
  const serverEffect = useMemo(
    () => Effect.flatMap(AppsAdminHttpApiClient, (c) => c.server.GetServer()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const appsPromise = useAppsEffect(appsEffect)
  const serverPromise = useAppsAdminEffect(serverEffect)

  const combined = useMemo(
    () => Promise.all([appsPromise, serverPromise] as const),
    [appsPromise, serverPromise]
  )

  return (
    <Suspense fallback={<p className="text-body-2">Loading apps…</p>}>
      <Await resolve={combined}>
        {([apps, server]: readonly [readonly AppEntry[], ServerState]) => (
          <AppsHomeBody
            server={server}
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
  readonly server: ServerState
  readonly apps: readonly AppEntry[]
  readonly onChanged: () => void
}

const AppsHomeBody = ({ server, apps, onChanged }: AppsHomeBodyProps): JSX.Element => {
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
    if (!app.requiresTunnel || server.tunnelActive) {
      window.location.href = target
      return
    }
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
          {server.tunnelActive ? <span className="text-label-4">tunnel</span> : null}
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
