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
import { type JSX, useMemo } from 'react'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { SyntheticDataScreen } from 'synthetic-data-react'

import { PUBLISHED_DATA_SET_ADDRESS } from './config.ts'
import styles from './app.module.css'

/**
 * The router context `synthetic-data-react` reads its authed runner through —
 * the shared shape, narrowed to the one slice client it needs.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext

/** The one route: `synthetic-data-react`'s screen, starting at the published data set. */
const LoaderRoute = (): JSX.Element => (
  <SyntheticDataScreen initialDataSetAddress={PUBLISHED_DATA_SET_ADDRESS} />
)

/** Props for {@link SyntheticDataApp}. */
interface SyntheticDataAppProps {
  /** The router context built from a completed SMART handshake. */
  readonly context: RouterContext
  /** The FHIR server the handshake connected to, named under the title. */
  readonly serverUrl: string
}

/**
 * The loader, mounted against an already-authenticated router context: the
 * title, the server it loads into, and `synthetic-data-react`'s screen, which
 * owns everything below.
 *
 * @remarks
 * A router exists because the screen reads its authed runner out of route
 * context (`fhir-r4-react`'s `useRunAuthed`). The history is a *memory*
 * history: this page is the OAuth redirect target, so its real URL carries
 * `?code=…&state=…`, which a browser history would match against the route
 * tree while the handshake still reads it. Split from {@link App} so a test
 * drives the whole tree over a stub transport.
 */
const SyntheticDataApp = ({ context, serverUrl }: SyntheticDataAppProps): JSX.Element => {
  // Memoised on the context so a re-render does not rebuild the router, and
  // with it the mounted screen and its load, underneath a running load.
  const router = useMemo(() => {
    const rootRoute = createRootRouteWithContext<RouterContext>()({})
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: LoaderRoute,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      context,
    })
  }, [context])

  return (
    <>
      <header className={styles.header}>
        <h1 className="text-heading-3">Synthetic Data Loader</h1>
        <p className={styles.server}>
          Loads into <code>{serverUrl}</code>
        </p>
      </header>
      <QueryClientProvider client={context.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </>
  )
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * loader against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake finishes before the router is built, because the router
 * context carries the HTTP layer, and the layer needs the token and the
 * server the handshake produces. A failed exchange goes back to the app root
 * (`useLaunchFailureRedirect`), which offers the connect menu.
 *
 * The transport is the plain `FetchHttpClient.layer`: the app's traffic is the
 * FHIR server the handshake named, the data set's own host (fetched without
 * credentials, by the screen) and, once the visitor consents in
 * `SmartAppRoot`'s dialog, Sentry — nothing starts telemetry from the build's
 * env without asking.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  useLaunchFailureRedirect(handshake)

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
    <main className={styles.app}>
      {handshake.kind === 'connecting' && <PageLoading message="Connecting…" />}
      {handshake.kind === 'error' && <ErrorBanner error={handshake.error} />}
      {context !== undefined && client !== undefined && (
        <SyntheticDataApp context={context} serverUrl={client.state.serverUrl} />
      )}
    </main>
  )
}

export { App, SyntheticDataApp, type SyntheticDataAppProps }
