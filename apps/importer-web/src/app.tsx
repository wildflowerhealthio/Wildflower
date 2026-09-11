import { FetchHttpClient } from '@effect/platform'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { PickedFile } from 'anonymizer-fundamentals'
import { AnonymizerScreen } from 'anonymizer-react'
import { type FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { buildSmartRouterContext, useSmartHandshake } from 'fhir-r4-react/smart'
import { ImporterScreen, ServerHarArchiveList } from 'importer-react'
import { useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageLoading, SegmentedToggle } from 'react-tundraish'

import styles from './app.module.css'

/**
 * The router context `importer-react` reads through — this app's instantiation
 * of the shared shape, narrowed to the one slice client it needs.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext

/** Which of the two screens the header toggle is showing. */
type Tab = 'import' | 'anonymize'

const tabOptions: readonly { value: Tab; label: string }[] = [
  { value: 'import', label: 'Import' },
  { value: 'anonymize', label: 'Anonymize' },
]

/**
 * The anonymizer shell is server-blind; this app has an authed FHIR context,
 * so it passes the importer slice's uploaded-archives list through the
 * `serverSource` slot. The importer's `PickedFile` and the anonymizer's
 * `PickedFile` both carry `{ fileName, bytes }`, so the adapter is now the
 * identity — nothing to re-encode.
 */
const ServerSource = ({ onPick }: { readonly onPick: (file: PickedFile) => void }): JSX.Element => (
  <ServerHarArchiveList
    onPick={(picked) => onPick({ fileName: picked.fileName, bytes: picked.bytes })}
  />
)

/** The subtitle each tab reads under the header. */
const subtitleFor = (tab: Tab): string =>
  tab === 'import'
    ? 'Import FHIR records from a captured browsing session.'
    : 'Replace every value in a capture with a pseudonym so its shape can be shared.'

/**
 * The importer surface: the app's title, the Import | Anonymize tabstrip, and
 * the one slice screen the picked tab mounts.
 *
 * @remarks
 * **This app renders no importing or anonymizing surface of its own.** Each tab
 * mounts one slice screen (`ImporterScreen` / `AnonymizerScreen`) that owns
 * every level below it — source pick, preview, confirm/download, results.
 * `ImporterScreen` takes no props and reads its authed runner out of route
 * context; `AnonymizerScreen` is server-blind and takes only the
 * `serverSource` slot this app fills with `ServerHarArchiveList`. The app owns
 * the tabstrip and the header copy, nothing else; see the traps in
 * [AGENTS.md](../AGENTS.md) for why splitting a flow across the app boundary is
 * the mistake this shape exists to avoid.
 *
 * The unselected screen is **unmounted**, not hidden — the same lesson
 * `apps/web-trace` records about split surfaces (an accessibility tree only
 * carries the surface the user is on, and the screen holds its own state so a
 * flip-back opens fresh at the picker).
 */
const ImporterHome = (): JSX.Element => {
  // Tab state lives inside `ImporterHome` — a per-render local — so the router
  // memo above stays keyed only on `context`. Lifting it into `ImporterApp`
  // would rebuild the router on every tab switch, taking the mounted tree with
  // it.
  const [tab, setTab] = useState<Tab>('import')
  return (
    <>
      <header className={styles['header']}>
        <h1 className="text-heading-3">Importer</h1>
        <div className={styles['controls']}>
          <SegmentedToggle value={tab} options={tabOptions} onChange={setTab} aria-label="View" />
        </div>
        <p className={cn(styles['subtitle'], 'text-body-3')}>{subtitleFor(tab)}</p>
      </header>

      {tab === 'import' ? <ImporterScreen /> : <AnonymizerScreen serverSource={ServerSource} />}
    </>
  )
}

/** Props for {@link ImporterApp}. */
interface ImporterAppProps {
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
 * A router exists for one reason: `importer-react` reads its authed runner out
 * of route context (`fhir-r4-react`'s `useRunAuthed`), which is how every other
 * consumer of that package's queries gets one — so this app supplies the same
 * shape rather than the package growing a second, prop-threaded way in.
 */
const ImporterApp = ({ context }: ImporterAppProps): JSX.Element => {
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
      component: ImporterHome,
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
 * importer against the FHIR server it was granted a token for.
 *
 * @remarks
 * The handshake has to finish before the router is built — the router context
 * carries the HTTP layer, and that layer needs the token and the server URL the
 * handshake produces. So a failed handshake renders as a failed handshake and
 * the importer never mounts, rather than mounting and offering an import whose
 * every write would 401.
 *
 * The exchange runs through {@link useSmartHandshake} rather than a raw
 * `useEffect` so it fires exactly once — a bare effect double-POSTs the
 * single-use authorization code under `React.StrictMode`. The page's one
 * `QueryClient` (from `main.tsx`, read here with `useQueryClient`) is handed to
 * the router context so the handshake and every app read/write share a cache.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()

  // Memoised on the (stable) resolved client so a re-render neither rebuilds the
  // context nor, through `ImporterApp`'s own memo, the router beneath it.
  //
  // Plain `FetchHttpClient.layer`, not `telemetry-react`'s `webHttpClientLayer`:
  // this app talks to exactly one host — the FHIR base the SMART handshake named
  // — and the telemetry layer would add a second, uninstrumented-by-this-app OTLP
  // destination to a bundle whose whole job is moving the user's records between
  // two places they chose. The handshake's `serverUrl` is the FHIR base verbatim
  // — the typed client emits base-relative paths, so there is no prefix to
  // reconcile and no failure arm here beyond the handshake's own.
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
      {handshake.kind === 'error' && (
        <p className={styles['error']}>
          Could not connect to the FHIR server:{' '}
          {handshake.error instanceof Error ? handshake.error.message : String(handshake.error)}
        </p>
      )}
      {context !== undefined && <ImporterApp context={context} />}
    </main>
  )
}

export { App, ImporterApp, type ImporterAppProps, ImporterHome }
