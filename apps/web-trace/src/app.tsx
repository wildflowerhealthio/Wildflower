import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { type FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { useId, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { DocumentsPanel, RecordingsPanel } from 'web-trace-react'

import styles from './app.module.css'

/**
 * The router context `web-trace-react` reads through — this app's instantiation
 * of the shared shape, narrowed to the one slice client it needs.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext

/** Which of the viewer's two panels is showing. */
type ViewerTab = 'recordings' | 'documents'

/** The tabs, in the order they render. */
const TABS: readonly { readonly id: ViewerTab; readonly label: string }[] = [
  { id: 'recordings', label: 'Recordings' },
  { id: 'documents', label: 'Documents' },
]

/**
 * The viewer surface: the app's title, the tabstrip, and whichever of the
 * slice's two panels is open.
 *
 * @remarks
 * **This app composes the tabs; it renders no viewing surface of its own**, and
 * the unselected panel is unmounted rather than hidden. Both rules exist
 * because breaking either reproduces the two-details-at-once collision — see
 * the traps in [AGENTS.md](../AGENTS.md).
 */
const ViewerScreen = (): JSX.Element => {
  const [tab, setTab] = useState<ViewerTab>('recordings')
  const tabPanelId = useId()

  return (
    <>
      <header className={styles['header']}>
        <h1 className="text-heading-3">Web Trace</h1>
        <p className={cn(styles['subtitle'], 'text-body-3')}>
          Browsing sessions and documents recorded on this device.
        </p>
      </header>

      <div className={styles['tabs']} role="tablist" aria-label="Web Trace views">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${tabPanelId}-${id}-tab`}
            aria-selected={tab === id}
            aria-controls={tabPanelId}
            className={cn(styles['tabs__tab'], tab === id && styles['tabs__tab--active'])}
            onClick={(): void => {
              setTab(id)
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div id={tabPanelId} role="tabpanel" aria-labelledby={`${tabPanelId}-${tab}-tab`}>
        {tab === 'recordings' ? <RecordingsPanel /> : <DocumentsPanel />}
      </div>
    </>
  )
}

/** Props for {@link TraceApp}. */
interface TraceAppProps {
  /** The router context built from a completed SMART handshake. */
  readonly context: RouterContext
}

/**
 * The viewer, mounted against an already-authenticated router context.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a stub
 * transport: the handshake is the only part that needs a browser redirect, and
 * everything below this point is the part worth testing.
 *
 * A router exists for one reason: `web-trace-react` reads its authed runner out
 * of route context (`fhir-r4-react`'s `useRunAuthed`), which is how every other
 * consumer of that package's queries gets one — so this app supplies the same
 * shape rather than the package growing a second, prop-threaded way in.
 */
const TraceApp = ({ context }: TraceAppProps): JSX.Element => {
  // The history is a *memory* history. This page is the OAuth redirect target,
  // so its real URL carries `?code=…&state=…`; a browser history would try to
  // match that against the route tree, and any navigation would rewrite the URL
  // the SMART handshake is still reading. The app has one screen — nothing
  // needs the address bar.
  //
  // Memoised on the context so a re-render does not rebuild the router (and
  // with it the mounted tree) underneath live query state.
  const router = useMemo(() => {
    const rootRoute = createRootRouteWithContext<RouterContext>()({})
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: ViewerScreen,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      context,
    })
  }, [context])

  return (
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * recordings viewer against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake has to finish before the router is built — the router context
 * carries the HTTP layer, and that layer needs the token and the server URL the
 * handshake produces. So a failed handshake renders as a failed handshake and
 * the viewer never mounts, rather than mounting and issuing unauthenticated
 * reads that all 401.
 *
 * The exchange runs through {@link useSmartHandshake} rather than a raw
 * `useEffect` so it fires exactly once — a bare effect double-POSTs the
 * single-use authorization code under `React.StrictMode`. The page's one
 * `QueryClient` (from `main.tsx`, read here with `useQueryClient`) is handed to
 * the router context so the handshake and every viewer read share a cache.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  // Memoised on the (stable) resolved client so a re-render neither rebuilds the
  // context nor, through `TraceApp`'s own memo, the router beneath it.
  //
  // Plain `FetchHttpClient.layer`, not `telemetry-react`'s `webHttpClientLayer`:
  // this app is registered `local_only = 1`, and the telemetry layer's OTLP
  // exporter is exactly the kind of outbound request that claim rules out. The
  // handshake's `serverUrl` is the FHIR base verbatim — the typed client emits
  // base-relative paths, so there is no prefix to reconcile and no failure arm
  // here beyond the handshake's own.
  const client = handshake.kind === 'ready' ? handshake.client : undefined
  const context = useMemo<RouterContext | undefined>(
    () =>
      client === undefined
        ? undefined
        : buildSmartRouterContext(
            {
              serverUrl: client.state.serverUrl,
              accessToken: client.state.tokenResponse?.access_token,
            },
            FetchHttpClient.layer,
            queryClient
          ),
    [client, queryClient]
  )

  return (
    <main className={styles['app']}>
      {handshake.kind === 'connecting' && <PageLoading message="Connecting…" />}
      {handshake.kind === 'error' && <ErrorBanner error={handshake.error} />}
      {context !== undefined && <TraceApp context={context} />}
    </main>
  )
}

export { App, TraceApp, type TraceAppProps, ViewerScreen }
