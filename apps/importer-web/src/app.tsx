import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { buildSmartRouterContext, type SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { PageLoading } from '@wildflowerhealthio/react-tundraish'
import { type SmartAppPage, SmartHandshakeGate } from '@wildflowerhealthio/smart-app-react'
import { useMemo, type JSX } from 'react'

import { buildRouter, type RouterContext } from './router.ts'
import styles from './app.module.css'

/** Props for {@link App}. */
interface AppProps {
  /** The page the app's router runs over. */
  readonly page: SmartAppPage
}

/** Props for {@link ImporterApp}. */
type ImporterAppProps = AppProps & {
  /** The router context built from a completed SMART handshake. */
  readonly context: RouterContext
}

/**
 * The importer, mounted against an already-authenticated router context.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a stub
 * transport: the handshake is the only part that needs a browser redirect, and
 * everything below this point is the part worth testing.
 *
 * The router reads the address bar, under the page's basepath, and each tab is
 * a child route of it, so the address bar names the open tab. It is built
 * under `smart-app-react`'s `SmartHandshakeGate`, so never before the
 * handshake is done with the callback URL.
 *
 * It also carries `importer-react`'s authed runner, which that package reads
 * out of route context (`fhir-r4-react`'s `useRunAuthed`), as every other
 * consumer of its queries does.
 *
 * Memoised on the context, so neither a re-render nor a tab switch (a
 * navigation inside this router) rebuilds it, and with it the mounted tree.
 */
const ImporterApp = ({ page, context }: ImporterAppProps): JSX.Element => {
  const router = useMemo(() => buildRouter(page, context), [page, context])

  return (
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/** Props for {@link LaunchedImporter}. */
type LaunchedImporterProps = AppProps & {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
}

/**
 * The importer over a completed handshake: the router context built from the
 * client it handed over, under {@link ImporterApp}.
 *
 * @remarks
 * Plain `FetchHttpClient.layer`: the app's only outbound traffic is the FHIR
 * server the SMART handshake named and, once the visitor consents in
 * `SmartAppRoot`'s dialog, Sentry. The handshake's `serverUrl` is the FHIR base
 * verbatim — the typed client emits base-relative paths, so there is no prefix
 * to reconcile.
 */
const LaunchedImporter = ({ page, client }: LaunchedImporterProps): JSX.Element => {
  const queryClient = useQueryClient()
  // Memoised on the (stable) resolved client so a re-render neither rebuilds the
  // context nor, through `ImporterApp`'s own memo, the router beneath it.
  const context = useMemo(
    () =>
      buildSmartRouterContext(
        {
          serverUrl: client.state.serverUrl,
          accessToken: client.state.tokenResponse?.access_token,
        },
        FetchHttpClient.layer,
        queryClient
      ),
    [client, queryClient]
  )
  return <ImporterApp page={page} context={context} />
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * importer against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake has to finish before the router is built — the router context
 * carries the HTTP layer, and that layer needs the token and the server URL the
 * handshake produces. So a failed handshake renders as a failed handshake and
 * the importer never mounts, rather than mounting and offering an import whose
 * every write would 401. The page's one `QueryClient` (`SmartAppRoot`'s, read
 * here with `useQueryClient`) is handed to the router context so the handshake
 * and every app read/write share a cache.
 */
const App = ({ page }: AppProps): JSX.Element => (
  <main className={styles['app']}>
    <SmartHandshakeGate page={page} connecting={<PageLoading message="Connecting…" />}>
      {(client) => <LaunchedImporter page={page} client={client} />}
    </SmartHandshakeGate>
  </main>
)

export { App, type AppProps, ImporterApp, type ImporterAppProps }
