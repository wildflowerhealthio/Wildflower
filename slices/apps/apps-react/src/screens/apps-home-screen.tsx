import { AppsHttpApiClient } from 'apps-core/clients'
import type { Apps, Server } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { Suspense, useEffect, useMemo, useState, type JSX } from 'react'
import { Await } from 'react-router'

import { isWebView, notifyReady, requestTunnel } from '../host-bridge.ts'
import { useAppsEffect } from '../use-apps-effect.ts'
import { AppsEditor } from './apps-editor.tsx'
import appsHome from '../styles/apps-home.module.css'
import pageLayout from '../styles/page.module.css'

type AppEntry = Schema.Schema.Type<typeof Apps.AppEntrySchema>
type ServerState = Schema.Schema.Type<typeof Server.ServerStateSchema>

interface AppsHomePayload {
  readonly server: ServerState
  readonly apps: readonly AppEntry[]
}

const AppsHomeScreen = (): JSX.Element => {
  const [refreshKey, setRefreshKey] = useState(0)

  const homeEffect = useMemo(
    () =>
      Effect.flatMap(AppsHttpApiClient, (client) =>
        Effect.all(
          {
            server: client.server.GetServer(),
            apps: client.apps.ListApps(),
          },
          { concurrency: 2 }
        )
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const homePromise: Promise<AppsHomePayload> = useAppsEffect(homeEffect)

  return (
    <Suspense fallback={<p>Loading apps…</p>}>
      <Await resolve={homePromise}>
        {({ server, apps }: AppsHomePayload) => (
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
  const inWebView = isWebView()

  useEffect(() => {
    notifyReady()
  }, [])

  const visible = apps.filter((app) => app.enabled)

  const launch = async (app: AppEntry): Promise<void> => {
    setError(null)
    // LaunchApp is GET /apps/:id which returns a 302 redirect; we set
    // window.location so the browser follows the redirect chain (and any
    // tunnel-side origin swap) just as a normal app-shell click would.
    const base = window.location.origin.replace(/\/$/, '')
    const target = `${base}/apps/${encodeURIComponent(app.id)}`
    if (!inWebView || !app.requiresTunnel || server.tunnelActive) {
      window.location.href = target
      return
    }
    try {
      const response = await requestTunnel()
      if (response.type === 'tunnelFailed') {
        setError(`Tunnel failed: ${response.reason}`)
        return
      }
      const newOrigin = response.origin.replace(/\/$/, '')
      window.location.href = `${newOrigin}/apps/${encodeURIComponent(app.id)}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={pageLayout['page']}>
      <header className={pageLayout['header']}>
        <h1 className={pageLayout['title']}>Apps</h1>
        <div className={appsHome['headerActions']}>
          {server.tunnelActive ? <span className={appsHome['tierBadge']}>tunnel</span> : null}
          <button
            className={appsHome['manageButton']}
            type="button"
            onClick={() => {
              setEditorOpen(true)
            }}
          >
            Manage
          </button>
        </div>
      </header>
      {error !== null ? (
        <p className={pageLayout['error']} role="alert">
          {error}
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p>No apps enabled. Tap Manage to turn some on.</p>
      ) : (
        <div className={appsHome['cardGrid']}>
          {visible.map((app) => (
            <button
              key={app.id}
              className={appsHome['card']}
              type="button"
              onClick={() => {
                void launch(app)
              }}
            >
              <span className={appsHome['cardTitle']}>{app.name}</span>
              <span className={appsHome['cardSubtitle']}>{app.subtitle}</span>
              <div className={appsHome['cardFooter']}>
                {app.requiresTunnel ? <span className={appsHome['tierBadge']}>tunnel</span> : null}
                <span>{app.kind}</span>
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
