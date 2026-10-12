import type { RouterHistory } from '@tanstack/react-router'
import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import type { TauriTransport } from '@wildflowerhealthio/effect-messaging-tauri-js'
import { usePromiseOrDefault } from '@wildflowerhealthio/react-kitchen-sink'
import { GateCard, PageBodyError, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'
import {
  RecorderPage,
  type RecorderPageProps,
  RecorderSenderProvider,
} from '@wildflowerhealthio/recorder-react'
import { PendingConsent } from '@wildflowerhealthio/servers-core-js'
import { BaseRoot, type BaseRootProps } from '@wildflowerhealthio/servers-react'
import { CrashReportingBoundary } from '@wildflowerhealthio/telemetry-react'
import { Either, Match, Option } from 'effect'
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore, type JSX } from 'react'

import styles from './host-shell.module.css'

/** The bridge transport the Recorder runs over: `RecorderBridge` alone. */
type RecorderTransport = TauriTransport<readonly [RecorderBridge]>

/** Where the Recorder's transport is. */
type RecorderConnection =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'Connected'; readonly transport: RecorderTransport }
  | { readonly _tag: 'Failed'; readonly error: unknown }

const CONNECTING: RecorderConnection = { _tag: 'Connecting' }

/**
 * The Recorder page, once its transport has told the host the page is ready,
 * inside the coordinator and sender it registers and sends through.
 */
function RecorderScreen({
  recorderTransport,
  page,
}: {
  readonly recorderTransport: Promise<RecorderTransport>
  readonly page: RecorderPageProps
}): JSX.Element {
  const connected = useMemo(
    () =>
      recorderTransport.then((transport): RecorderConnection => ({ _tag: 'Connected', transport })),
    [recorderTransport]
  )
  const connection = usePromiseOrDefault<RecorderConnection>(connected, CONNECTING, (error) => ({
    _tag: 'Failed',
    error,
  }))
  return Match.value(connection).pipe(
    Match.tag('Connecting', () => (
      <div className={pageLayoutStyles['page']}>
        <GateCard title="Connecting to the recorder…" />
      </div>
    )),
    Match.tag('Failed', ({ error }) => (
      <div className={pageLayoutStyles['page']}>
        <PageBodyError title="The recorder couldn't connect" error={error} />
      </div>
    )),
    Match.tag('Connected', ({ transport }) => (
      <HandlerCoordinatorContext.Provider value={transport.coordinator}>
        <RecorderSenderProvider send={transport.sendMessage}>
          <RecorderPage {...page} />
        </RecorderSenderProvider>
      </HandlerCoordinatorContext.Provider>
    )),
    Match.exhaustive
  )
}

/** The shell's one route of its own: the Recorder. Every other path is the base's. */
const RECORDER_PATH = '/recorder'

/** Where the shell is: which page shows, and where its Servers link goes. */
interface HostRoute {
  /** Whether the location is {@link RECORDER_PATH}, so the Recorder shows. */
  readonly onRecorder: boolean
  /**
   * The base's last location, `/` until the base has had one: where the
   * Servers link goes, so coming back finds the base where it was left.
   */
  readonly serversHref: string
}

/** The shell's {@link HostRoute}, read from `history` as it navigates. */
const useHostRoute = (history: RouterHistory): HostRoute => {
  const location = useSyncExternalStore(history.subscribe, () => history.location)
  const onRecorder = location.pathname === RECORDER_PATH
  const [serversHref, setServersHref] = useState(onRecorder ? '/' : location.href)
  if (!onRecorder && serversHref !== location.href) setServersHref(location.href)
  return { onRecorder, serversHref }
}

/**
 * Navigate to the base whenever a consent comes to wait on a server, so the
 * base's consent sheet is on screen to answer.
 */
const useServersForPendingConsents = (
  listen: BaseRootProps['listen'],
  history: RouterHistory,
  { onRecorder, serversHref }: HostRoute
): void => {
  const showServers = useEffectEvent(() => {
    if (onRecorder) history.push(serversHref)
  })
  useEffect(() => {
    let unmounted = false
    let stopListening: (() => void) | undefined
    void listen(PendingConsent.EVENT, ({ payload }) => {
      Either.map(PendingConsent.decodeEvent(payload), ({ head }) => {
        if (Option.isSome(head)) showServers()
      })
    }).then((stop) => {
      if (unmounted) {
        stop()
        return
      }
      stopListening = stop
    })
    return () => {
      unmounted = true
      stopListening?.()
    }
  }, [listen])
}

/** Props for {@link HostShell}. */
interface HostShellProps {
  /** The base's props, passed to `BaseRoot` with {@link HostShellProps.history}. */
  readonly base: Omit<BaseRootProps, 'history'>
  /**
   * The window's history, which the shell's links and the base's router both
   * navigate: `createBrowserHistory()` in the app, a memory one in tests.
   */
  readonly history: RouterHistory
  /**
   * The Recorder's bridge transport: `makeTauriTransport` over
   * `RecorderBridge`, which resolves once the host has been told the page is
   * ready.
   */
  readonly recorderTransport: Promise<RecorderTransport>
  /**
   * Show a saved recording in the file manager: `tauri-plugin-opener`'s
   * `revealItemInDir`. The Recorder page reads its folder with the base's
   * `invoke`.
   */
  readonly revealFile: RecorderPageProps['revealFile']
}

/**
 * The host's main window: a bar of two links, Servers (the base,
 * `servers-react`'s `BaseRoot`) and Recorder (`recorder-react`'s
 * `RecorderPage`), over the page the location names.
 *
 * @remarks
 * **The location picks the page.** `/recorder` is the Recorder; every other
 * path is the base's, which its router, on the same `history`, routes. The
 * links navigate that history, so the platform's Back moves between them too.
 * The Servers link goes to the base's last location rather than `/`.
 *
 * **Both pages stay mounted.** The one the location doesn't name is hidden,
 * not unmounted, so a running recording keeps going while the base shows.
 *
 * **The base's gates stay in the base.** `BaseRoot` holds its own telemetry
 * consent dialog, which is modal, so on first launch it covers the bar too and
 * nothing else can be reached until it is answered. The Recorder has a
 * `CrashReportingBoundary` of its own, whose reports are sent once that answer
 * has started telemetry.
 *
 * **A consent navigates to the base.** The base's consent sheet is the base's,
 * so when the host emits a consent waiting on a server while the Recorder
 * shows, the shell navigates to the Servers link's location.
 */
function HostShell({ base, history, recorderTransport, revealFile }: HostShellProps): JSX.Element {
  const route = useHostRoute(history)
  useServersForPendingConsents(base.listen, history, route)
  const links = [
    { label: 'Servers', href: route.serversHref, current: !route.onRecorder },
    { label: 'Recorder', href: RECORDER_PATH, current: route.onRecorder },
  ]
  return (
    <div className={styles['host-shell']}>
      <nav className={styles['host-shell__nav']} aria-label="Wildflower Host">
        {links.map(({ label, href, current }) => (
          <a
            key={label}
            href={history.createHref(href)}
            aria-current={current ? 'page' : undefined}
            className={`text-label-2 ${styles['host-shell__link']}`}
            onClick={(event) => {
              const plainClick =
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              if (!plainClick) return
              event.preventDefault()
              if (!current) history.push(href)
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <div hidden={route.onRecorder} className={styles['host-shell__page']}>
        <BaseRoot {...base} history={history} />
      </div>
      <div hidden={!route.onRecorder} className={styles['host-shell__page']}>
        <CrashReportingBoundary extraContext={{ app: base.telemetry.app, page: 'recorder' }}>
          <RecorderScreen
            recorderTransport={recorderTransport}
            page={{ invoke: base.invoke, revealFile }}
          />
        </CrashReportingBoundary>
      </div>
    </div>
  )
}

export { HostShell, type HostShellProps, type RecorderTransport }
