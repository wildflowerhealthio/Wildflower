import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { stripTrailingSlash } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, ItemList, PageHeader, type ItemListItem } from 'react-tundraish'
import { tunnelStateQueryOptions, useTunnelStateQuery, type TunnelState } from 'tunnel-react'

import { appsListQueryOptions, useAppsListQuery, type AppEntry } from '../../../queries.ts'
import { useAppsSender } from '../../../runtime/use-apps-sender.ts'
import { useRequestTunnel } from '../../../runtime/use-request-tunnel.ts'
import { AppsEditor } from '../../../screens/apps-editor.tsx'
import { launchTarget } from './launch-target.ts'
import pageLayout from '../../../styles/page.module.css'

/**
 * Whether the SPA is running inside the Tauri host. `withGlobalTauri` exposes
 * `window.__TAURI__` there; on standalone web it's absent. In the host we open
 * a launched app in the sandboxed webview (a separate, less-privileged window
 * with the shared browser top bar) so the main SPA stays put; on web we
 * navigate the page directly. The `'__TAURI__' in window` string-key form keeps
 * the no-underscore-dangle lint happy.
 */
const isTauriHost = (): boolean => typeof window !== 'undefined' && '__TAURI__' in window

/**
 * Owner-facing apps landing. The route `loader` warms both queries in
 * parallel against the shared `QueryClient`; by the time the component
 * renders, `useAppsListQuery` / `useTunnelStateQuery` resolve
 * synchronously from cache. The router's own pending UI covers the
 * load window — no inline `<Suspense>` fallback, no `<CatchBoundary>`;
 * read failures propagate to the route's `errorComponent`. Mutations
 * triggered inside `<AppsEditor>` auto-invalidate the list query.
 */
const AppsHomeScreen = (): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  const { data: tunnel } = useTunnelStateQuery()
  return <AppsHomeBody apps={apps} tunnel={tunnel} />
}

interface AppsHomeBodyProps {
  readonly tunnel: TunnelState
  readonly apps: readonly AppEntry[]
}

const AppsHomeBody = ({ tunnel, apps }: AppsHomeBodyProps): JSX.Element => {
  const [editorOpen, setEditorOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestTunnel = useRequestTunnel()
  const send = useAppsSender()

  const visible = apps.filter((app) => app.enabled)

  /**
   * Send the browser to the resolved launch URL. Inside the Tauri host this
   * opens the app in the sandboxed webview via the bridge (a separate window,
   * leaving the SPA mounted); on standalone web it navigates the page directly,
   * following the `GET /apps/:id` 302 redirect chain (and any tunnel-side origin
   * swap) just as a normal app-shell click would.
   */
  const openLaunchUrl = (url: string): void => {
    if (isTauriHost()) {
      // Fire-and-forget — there is no host→web reply. Defects are logged, not
      // surfaced, so the click handler can't blow up (mirrors useRequestTunnel).
      Effect.runFork(
        send({ _tag: 'RequestSandboxedWebView', url }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('launch: RequestSandboxedWebView send failed', cause)
          )
        )
      )
      return
    }
    window.location.href = url
  }

  const launch = async (app: AppEntry): Promise<void> => {
    setError(null)
    // Origin policy (see [`launchTarget`]):
    //  - Non-tunnel apps always go through `window.location.origin`, which the
    //    embedded shell pins to the loopback origin. That keeps the redirect off
    //    the public tunnel even when one is up (avoiding localtunnel's 511
    //    captive-portal interstitial).
    //  - Tunnel apps explicitly target `tunnel.servedOrigin` — the
    //    server-resolved public URL — only while the tunnel is `verified` (the
    //    one status where `servedOrigin` is the public origin). For any other
    //    status `servedOrigin` is still the loopback fallback, so we ask the
    //    host to bring the tunnel up via the bridge and await its verified
    //    origin instead of redirecting to loopback (which would silently bypass
    //    the tunnel).
    const launchPath = `/apps/${encodeURIComponent(app.id)}`
    const target = launchTarget(app, tunnel)
    if (target.via === 'loopback') {
      openLaunchUrl(`${stripTrailingSlash(window.location.origin)}${launchPath}`)
      return
    }
    if (target.via === 'served') {
      openLaunchUrl(`${stripTrailingSlash(target.origin)}${launchPath}`)
      return
    }
    const response = await requestTunnel()
    if ('error' in response) {
      setError(`Tunnel failed: ${response.error}`)
      return
    }
    openLaunchUrl(`${stripTrailingSlash(response.origin)}${launchPath}`)
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
    </>
  )
}

export const Route = createFileRoute('/_auth/home/')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(appsListQueryOptions(context.runAuthed)),
      context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed)),
    ]),
  component: AppsHomeScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})
