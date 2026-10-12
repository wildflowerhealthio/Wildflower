import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import type { TauriTransport } from '@wildflowerhealthio/effect-messaging-tauri-js'
import { usePromiseOrDefault } from '@wildflowerhealthio/react-kitchen-sink'
import { GateCard, PageBodyError, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'
import { RecorderPage, RecorderSenderProvider } from '@wildflowerhealthio/recorder-react'
import { PendingConsent } from '@wildflowerhealthio/servers-core-js'
import { BaseRoot, type BaseRootProps } from '@wildflowerhealthio/servers-react'
import { CrashReportingBoundary } from '@wildflowerhealthio/telemetry-react'
import { Either, Match, Option } from 'effect'
import { useEffect, useId, useMemo, useState, type JSX } from 'react'

import styles from './host-shell.module.css'

/** The bridge transport the Recorder tab runs over: `RecorderBridge` alone. */
type RecorderTransport = TauriTransport<readonly [RecorderBridge]>

/** The shell's tabs, in the order the bar shows them. */
const TABS = [
  { id: 'servers', label: 'Servers' },
  { id: 'recorder', label: 'Recorder' },
] as const

/** The id of one of the shell's {@link TABS}. */
type Tab = (typeof TABS)[number]['id']

/** Where the Recorder tab's transport is. */
type RecorderConnection =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'Connected'; readonly transport: RecorderTransport }
  | { readonly _tag: 'Failed'; readonly error: unknown }

const CONNECTING: RecorderConnection = { _tag: 'Connecting' }

/**
 * The Recorder page, once its transport has told the host the page is ready,
 * inside the coordinator and sender it registers and sends through.
 */
function RecorderTab({
  recorderTransport,
}: {
  readonly recorderTransport: Promise<RecorderTransport>
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
          <RecorderPage />
        </RecorderSenderProvider>
      </HandlerCoordinatorContext.Provider>
    )),
    Match.exhaustive
  )
}

/**
 * Show the Servers tab whenever a consent comes to wait on a server, so the
 * base's consent sheet, which lives in that tab, is on screen to answer.
 */
const useServersTabForPendingConsents = (
  listen: BaseRootProps['listen'],
  showServers: () => void
): void => {
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
  }, [listen, showServers])
}

/** Props for {@link HostShell}. */
interface HostShellProps {
  /** The base's props, passed to `BaseRoot` unchanged. */
  readonly base: BaseRootProps
  /**
   * The Recorder tab's bridge transport: `makeTauriTransport` over
   * `RecorderBridge`, which resolves once the host has been told the page is
   * ready.
   */
  readonly recorderTransport: Promise<RecorderTransport>
}

/**
 * The host's main window: a bar with two tabs, Servers (the base,
 * `servers-react`'s `BaseRoot`) and Recorder (`recorder-react`'s
 * `RecorderPage`).
 *
 * @remarks
 * **Both tabs stay mounted.** The inactive one is hidden, not unmounted, so
 * switching keeps the base's router and a running recording where they were.
 *
 * **The base's gates stay in the base.** `BaseRoot` holds its own telemetry
 * consent dialog, which is modal, so on first launch it covers the bar too and
 * nothing else can be reached until it is answered; Servers is the tab the
 * shell opens on. The Recorder tab has a `CrashReportingBoundary` of its own,
 * whose reports are sent once that answer has started telemetry.
 *
 * **A consent shows the Servers tab.** The base's consent sheet lives in the
 * Servers tab, so when the host emits a consent waiting on a server, the shell
 * shows that tab.
 */
function HostShell({ base, recorderTransport }: HostShellProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('servers')
  const [showServers] = useState(() => () => {
    setTab('servers')
  })
  useServersTabForPendingConsents(base.listen, showServers)
  const panelId = useId()
  const tabIdOf = (id: Tab): string => `${panelId}-${id}-tab`
  const panelIdOf = (id: Tab): string => `${panelId}-${id}-panel`
  return (
    <div className={styles['host-shell']}>
      <div className={styles['host-shell__tabs']} role="tablist" aria-label="Wildflower Host">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={tabIdOf(id)}
            aria-selected={tab === id}
            aria-controls={panelIdOf(id)}
            className={`text-label-2 ${styles['host-shell__tab']}`}
            onClick={() => {
              setTab(id)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={panelIdOf('servers')}
        role="tabpanel"
        aria-labelledby={tabIdOf('servers')}
        hidden={tab !== 'servers'}
        className={styles['host-shell__panel']}
      >
        <BaseRoot {...base} />
      </div>
      <div
        id={panelIdOf('recorder')}
        role="tabpanel"
        aria-labelledby={tabIdOf('recorder')}
        hidden={tab !== 'recorder'}
        className={styles['host-shell__panel']}
      >
        <CrashReportingBoundary extraContext={{ app: base.telemetry.app, tab: 'recorder' }}>
          <RecorderTab recorderTransport={recorderTransport} />
        </CrashReportingBoundary>
      </div>
    </div>
  )
}

export { HostShell, type HostShellProps, type RecorderTransport }
