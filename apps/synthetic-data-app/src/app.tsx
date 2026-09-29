import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
  useRouteContext,
} from '@tanstack/react-router'
import type { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { type JSX, useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'
import { LoadingLine } from 'smart-app-react'
import { SyntheticDataScreen } from 'synthetic-data-react'

import { rememberDataSetUrl, rememberedDataSetUrl } from './data-set-url-memory.ts'
import styles from './app.module.css'

/**
 * The router context `synthetic-data-react` reads its authed runner through,
 * plus the FHIR server the handshake named, which the page shows as where a
 * load writes.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext & {
  readonly serverUrl: string
}

/**
 * The page: the title, and the slice's load screen with the data set URL
 * this tab remembers.
 */
const SyntheticDataHome = (): JSX.Element => {
  const serverUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.serverUrl,
  })
  const [dataSetUrl, setDataSetUrl] = useState(() => rememberedDataSetUrl(window.sessionStorage))
  const changeDataSetUrl = (nextDataSetUrl: string): void => {
    rememberDataSetUrl(window.sessionStorage, nextDataSetUrl)
    setDataSetUrl(nextDataSetUrl)
  }
  return (
    <>
      <header className={styles.header}>
        <h1 className="text-heading-3">Synthetic Data Loader</h1>
        <p className={cn(styles.subtitle, 'text-body-3')}>
          Load people from a published synthetic data set into this FHIR server.
        </p>
      </header>
      <SyntheticDataScreen
        serverUrl={serverUrl}
        dataSetUrl={dataSetUrl}
        onDataSetUrlChange={changeDataSetUrl}
      />
    </>
  )
}

/** Props for {@link SyntheticDataApp}. */
interface SyntheticDataAppProps {
  /** The router context built from a completed SMART handshake. */
  readonly context: RouterContext
}

/**
 * The loader, mounted against an already-authenticated router context.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a stub
 * transport. A router exists because `synthetic-data-react` reads its authed
 * runner out of route context (`fhir-r4-react`'s `useRunAuthed`), as
 * `apps/importer-web` supplies it to `importer-react`. The history is a memory
 * history: this page is the OAuth redirect target, so its real URL carries
 * `?code=…&state=…`, which a browser history would try to route. Memoised on
 * the context so a re-render does not rebuild the router under live state.
 */
const SyntheticDataApp = ({ context }: SyntheticDataAppProps): JSX.Element => {
  const router = useMemo(() => {
    const rootRoute = createRootRouteWithContext<RouterContext>()({})
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: SyntheticDataHome,
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
 * loader against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake has to finish before the router is built — the router context
 * carries the HTTP layer, which needs the token and the server URL the
 * handshake produces. The shell's one `QueryClient` is handed to the router
 * context, so the handshake and every read share a cache. Plain
 * `FetchHttpClient.layer`, as `apps/importer-web` uses: the app talks to one
 * FHIR server, and reads the data set with `fetch` (no token, since the data
 * set's host issued none).
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const client = handshake.kind === 'ready' ? handshake.client : undefined
  const context = useMemo<RouterContext | undefined>(
    () =>
      client === undefined
        ? undefined
        : {
            ...buildSmartRouterContext(
              {
                serverUrl: client.state.serverUrl,
                accessToken: client.state.tokenResponse?.access_token,
              },
              FetchHttpClient.layer,
              queryClient
            ),
            serverUrl: client.state.serverUrl,
          },
    [client, queryClient]
  )

  return (
    <main className={styles.app}>
      {handshake.kind === 'connecting' && <LoadingLine />}
      {handshake.kind === 'error' && <ErrorBanner error={handshake.error} />}
      {context !== undefined && <SyntheticDataApp context={context} />}
    </main>
  )
}

export { App, SyntheticDataApp, type SyntheticDataAppProps }
