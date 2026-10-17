import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import {
  buildSmartRouterContext,
  type SmartHandshake,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { useMemo, type JSX } from 'react'

import { buildRouter, type RouterContext } from './router.ts'
import styles from './app.module.css'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

/** Props for {@link ImporterApp}. */
interface ImporterAppProps {
  /** The window's history, which the router navigates. */
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
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
 * The router reads the address bar, under `basepath`, and each tab is a child
 * route of it, so a tab can be linked to. It is mounted only once the SMART
 * handshake has completed, by when fhirclient has taken `code` and `state` out
 * of the address bar: the router matches the URL and redirects `/` to a tab, so
 * building it any earlier could rewrite the callback URL the token exchange
 * still reads.
 *
 * It also carries `importer-react`'s authed runner, which that package reads
 * out of route context (`fhir-r4-react`'s `useRunAuthed`), as every other
 * consumer of its queries does.
 *
 * Memoised on the context, so neither a re-render nor a tab switch (a
 * navigation inside this router) rebuilds it, and with it the mounted tree.
 */
const ImporterApp = ({ history, basepath, context }: ImporterAppProps): JSX.Element => {
  const router = useMemo(
    () => buildRouter({ history, basepath, context }),
    [history, basepath, context]
  )

  return (
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/** Props for {@link LaunchedImporter}. */
interface LaunchedImporterProps {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** The window's history, which the router navigates. */
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
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
const LaunchedImporter = ({ client, history, basepath }: LaunchedImporterProps): JSX.Element => {
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
  return <ImporterApp history={history} basepath={basepath} context={context} />
}

/** Props for {@link App}. */
interface AppProps {
  /** The window's history, which the router navigates once the handshake completes. */
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * importer against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake has to finish before the router is built — the router context
 * carries the HTTP layer, and that layer needs the token and the server URL the
 * handshake produces, and the router must not read the address bar while the
 * callback's `code` and `state` are still in it. So a failed handshake renders
 * as a failed handshake and the importer never mounts, rather than mounting and
 * offering an import whose every write would 401.
 *
 * The exchange runs through {@link useSmartHandshake} rather than a raw
 * `useEffect` so it fires exactly once — a bare effect double-POSTs the
 * single-use authorization code under `React.StrictMode`. The page's one
 * `QueryClient` (`SmartAppRoot`'s, read here with `useQueryClient`) is handed to
 * the router context so the handshake and every app read/write share a cache.
 */
const App = ({ history, basepath }: AppProps): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <PageLoading message="Connecting…" />),
    Match.when({ kind: 'ready' }, ({ client }) => (
      <LaunchedImporter client={client} history={history} basepath={basepath} />
    )),
    Match.exhaustive
  )

  return <main className={styles['app']}>{body}</main>
}

export { App, type AppProps, ImporterApp, type ImporterAppProps }
