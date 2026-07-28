import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { readySmartClient } from 'fhir-r4-react/smart'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageLoading } from 'react-tundraish'
import type { TraceExchange } from 'web-trace-core'
import { RecordingsPanel } from 'web-trace-react'

import { ExchangeDetail } from './exchange-detail.tsx'
import { buildSmartRouterContext, type RouterContext } from './smart-runtime.ts'
import styles from './app.module.css'

/**
 * The recordings surface: the slice's panel, plus the exchange detail the panel
 * deliberately leaves to its host.
 *
 * @remarks
 * Selection lives here rather than in the panel because the panel's contract is
 * that the host owns the detail surface — see `RecordingsPanelProps`.
 */
const RecordingsScreen = (): JSX.Element => {
  const [selected, setSelected] = useState<TraceExchange | null>(null)
  return (
    <>
      <header className={styles['header']}>
        <h1 className="text-heading-3">Web Trace</h1>
        <p className={cn(styles['subtitle'], 'text-body-3')}>
          Browsing sessions recorded on this device.
        </p>
      </header>
      {selected === null ? (
        <RecordingsPanel onSelectExchange={setSelected} />
      ) : (
        <ExchangeDetail
          exchange={selected}
          onClose={(): void => {
            setSelected(null)
          }}
        />
      )}
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
      component: RecordingsScreen,
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

type LoadState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly context: RouterContext }

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
 */
const App = (): JSX.Element => {
  const [state, setState] = useState<LoadState>({ kind: 'connecting' })

  useEffect(() => {
    let cancelled = false
    readySmartClient()
      .then((client) => {
        if (cancelled) return
        setState({
          kind: 'ready',
          // Plain `FetchHttpClient.layer`, not `telemetry-react`'s
          // `webHttpClientLayer`: this app is registered `local_only = 1`, and
          // the telemetry layer's OTLP exporter is exactly the kind of outbound
          // request that claim rules out.
          context: buildSmartRouterContext(
            {
              serverUrl: client.state.serverUrl,
              accessToken: client.state.tokenResponse?.access_token,
            },
            FetchHttpClient.layer
          ),
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  return (
    <main className={styles['app']}>
      {state.kind === 'connecting' && <PageLoading message="Connecting…" />}
      {state.kind === 'error' && (
        <p className={styles['error']}>
          Could not connect to this device&rsquo;s FHIR server: {state.message}
        </p>
      )}
      {state.kind === 'ready' && <TraceApp context={state.context} />}
    </main>
  )
}

export { App, RecordingsScreen, TraceApp, type TraceAppProps }
