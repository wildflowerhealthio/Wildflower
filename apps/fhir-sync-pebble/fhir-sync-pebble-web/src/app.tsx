import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
  useRouteContext,
} from '@tanstack/react-router'
import type { FhirR4ResourcesRouterContext } from '@wildflowerhealthio/fhir-r4-react'
import { buildSmartRouterContext, type SmartRuntime } from '@wildflowerhealthio/fhir-r4-react/smart'
import { PebbleSettings } from '@wildflowerhealthio/fhir-sync-pebble-core'
import { ReturnTargetStore } from '@wildflowerhealthio/pebble-configuration'
import { PageLoading } from '@wildflowerhealthio/react-tundraish'
import { SmartHandshakeGate } from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'
import { useMemo, useState, type JSX } from 'react'

import { RETURN_TO_STORAGE_KEY, smartRegistration } from './config.ts'
import { SettingsPage, type SettingsPageProps } from './settings-page.tsx'
import styles from './app.module.css'

/**
 * The router context: what the patient search reads its authed runner from
 * (`fhir-r4-react`'s `useRunAuthed`), plus the settings page's inputs, which the
 * route reads back out.
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
 * A router exists for one reason: the patient search takes its authed runner
 * from route context (`fhir-r4-react`'s `useRunAuthed`), which is how every
 * SMART app's reads get one. The history is a *memory*
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

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * settings page against the FHIR server it was granted a token for.
 *
 * @remarks
 * Only `ConnectedSettingsApp` sees the SMART runtime: it turns the handshake
 * into a router context (reads) and the connection the watch will get (the
 * grant), and nothing below it holds the runtime.
 *
 * The exchange runs under `smart-app-react`'s `SmartHandshakeGate`, so it
 * fires exactly once — a bare effect double-POSTs the single-use
 * authorization code under `React.StrictMode`. A failed exchange is carried
 * back to the app root, which can offer the connect menu again.
 *
 * The page's only outbound traffic is the FHIR base the handshake named and,
 * once the visitor consents in `SmartAppRoot`'s dialog, Sentry.
 */
const App = (): JSX.Element => (
  <main className={styles['app']}>
    <SmartHandshakeGate
      registration={smartRegistration}
      connecting={<PageLoading message="Connecting…" />}
    >
      {(runtime) => <ConnectedSettingsApp runtime={runtime} />}
    </SmartHandshakeGate>
  </main>
)

/** {@link SettingsApp} over a completed handshake's `runtime`, on the page's one `QueryClient`. */
const ConnectedSettingsApp = ({ runtime }: { readonly runtime: SmartRuntime }): JSX.Element => {
  const queryClient = useQueryClient()
  const [returnTargets] = useState(() =>
    ReturnTargetStore.fromWebStorage(window.sessionStorage, RETURN_TO_STORAGE_KEY)
  )
  const context = useMemo(
    () => buildSmartRouterContext(runtime, queryClient),
    [runtime, queryClient]
  )
  return (
    <SettingsApp
      context={context}
      connection={PebbleSettings.fromGrant({
        accessToken: Option.getOrUndefined(runtime.connection.accessToken),
        fhirBaseUrl: runtime.connection.fhirBaseUrl,
      })}
      returnTargets={returnTargets}
      navigate={assignLocation}
    />
  )
}

export { App, SettingsApp, type SettingsAppProps }
