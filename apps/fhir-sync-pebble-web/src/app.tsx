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
import type { Either } from 'effect'
import type { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { useMemo, useState, type JSX } from 'react'
import { ErrorBanner, PageLoading } from 'react-tundraish'

import * as PebbleSettings from './pebble-settings.ts'
import * as ReturnTargetStore from './return-target-store.ts'
import { SettingsPage, type SettingsPageProps } from './settings-page.tsx'
import styles from './app.module.css'

/**
 * The router context: what `fhir-r4-react`'s queries read their authed runner
 * from, plus the settings page's inputs, which the route reads back out.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext & {
  readonly settingsPage: SettingsPageProps
}

/** Leaves the page for the Pebble hand-off URL. */
const assignLocation = (url: string): void => {
  window.location.assign(url)
}

/** The one route: the settings page, fed from router context. */
const SettingsRoute = (): JSX.Element => {
  const props = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.settingsPage,
  })
  return <SettingsPage {...props} />
}

/** Props for {@link SettingsApp}. */
interface SettingsAppProps extends SettingsPageProps {
  /** The router context built from a completed SMART handshake. */
  readonly context: FhirR4ResourcesRouterContext.RouterContext
}

/**
 * The settings page, mounted against an already-authenticated router context.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a stub
 * transport: the handshake is the only part that needs a browser redirect.
 *
 * A router exists for one reason: `fhir-r4-react`'s patient read takes its
 * authed runner from route context (`useRunAuthed`), which is how every
 * consumer of that package's queries gets one. The history is a *memory*
 * history — this page is the OAuth redirect target, so its real URL carries
 * `?code=…&state=…`, which a browser history would try to route. Memoised on
 * its inputs so a re-render does not rebuild the router under live query state.
 */
const SettingsApp = ({
  context,
  connection,
  returnTargets,
  navigate,
}: SettingsAppProps): JSX.Element => {
  const router = useMemo(() => {
    const rootRoute = createRootRouteWithContext<RouterContext>()({})
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: SettingsRoute,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      context: { ...context, settingsPage: { connection, returnTargets, navigate } },
    })
  }, [context, connection, returnTargets, navigate])

  return (
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/** A completed handshake's router context and the connection its grant carried. */
interface Session {
  readonly context: FhirR4ResourcesRouterContext.RouterContext
  readonly connection: Either.Either<PebbleSettings.Connection, PebbleSettings.MissingGrantError>
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * settings page against the FHIR server it was granted a token for.
 *
 * @remarks
 * This is the only component that sees the fhirclient `Client`: it turns the
 * handshake into a router context (reads) and the connection the watch will
 * get (the grant), and nothing below it holds the client.
 *
 * The exchange runs through {@link useSmartHandshake} so it fires exactly once —
 * a bare effect double-POSTs the single-use authorization code under
 * `React.StrictMode`. A failed exchange is carried back to the app root, which
 * can offer the connect menu again.
 *
 * Plain `FetchHttpClient.layer`: the page talks to exactly one host, the FHIR
 * base the handshake named.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  useLaunchFailureRedirect(handshake)
  const [returnTargets] = useState(() => ReturnTargetStore.fromWebStorage(window.sessionStorage))

  const client = handshake.kind === 'ready' ? handshake.client : undefined
  const session = useMemo<Session | undefined>(() => {
    if (client === undefined) return undefined
    const accessToken = client.state.tokenResponse?.access_token
    return {
      context: buildSmartRouterContext(
        { serverUrl: client.state.serverUrl, accessToken },
        FetchHttpClient.layer,
        queryClient
      ),
      connection: PebbleSettings.fromGrant({
        patientId: client.patient.id,
        accessToken,
        fhirBaseUrl: client.state.serverUrl,
      }),
    }
  }, [client, queryClient])

  return (
    <main className={styles['app']}>
      {handshake.kind === 'connecting' && <PageLoading message="Connecting…" />}
      {handshake.kind === 'error' && <ErrorBanner error={handshake.error} />}
      {session !== undefined && (
        <SettingsApp
          context={session.context}
          connection={session.connection}
          returnTargets={returnTargets}
          navigate={assignLocation}
        />
      )}
    </main>
  )
}

export { App, SettingsApp, type SettingsAppProps }
