import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { type DateTime, Match, Option } from 'effect'
import { type JSX, type ReactNode, useId, useState } from 'react'
import {
  ConfirmDialog,
  ErrorBanner,
  GateCard,
  ItemList,
  type ItemListItem,
  PageBodyError,
  PageHeader,
  StatusBadge,
  TextField,
} from 'react-tundraish'
import {
  type CertificateAuthority,
  CertificateState,
  type HealthReport,
  HostCommandFailed,
  type HostCommandError,
  type ListedServer,
  ServerStatus,
} from 'servers-core-js'

import { failureText } from './failure-text.ts'
import { LaunchButton } from './launch-button.tsx'
import {
  type ServerHealthError,
  serverHealthQueryOptions,
  serversQueryOptions,
  useRemoveServer,
  useServerStatusEvents,
  useSetServerCredentials,
  useUpdateLauncher,
} from './queries.ts'
import type { RouterContext, RunHostCommand, RunHttpRequest } from './router-context.ts'
import { RunPolicyPicker } from './run-policy-picker.tsx'
import {
  formatInstant,
  lastStopText,
  PLATFORM_STOP_REASON_TEXT,
  statusSummary,
} from './server-status-text.ts'
import { useHasPassed } from './use-has-passed.ts'
import styles from './server-page.module.css'

/** What the Relay row says of each kind of relay. */
const relayText = (relay: ListedServer.Relay): string => {
  if (relay.kind === 'selfHostedWildflower') {
    return `Self-hosted Wildflower relay at ${relay.baseUrl}`
  }
  return relay.kind === 'wildflowerOfficial' ? 'Wildflower relay' : 'Rathole server'
}

/** What the Certificate authority row says of each CA. */
const CERTIFICATE_AUTHORITY_TEXT: Readonly<Record<CertificateAuthority.Type, string>> = {
  letsEncrypt: "Let's Encrypt",
  letsEncryptStaging: "Let's Encrypt staging, which browsers don't trust",
}

/** What the certificate's Status row says of each status. */
const CERTIFICATE_STATUS_TEXT: Readonly<Record<CertificateState.Status, string>> = {
  notIssued: 'None yet. The server orders one when it runs.',
  ordering: 'Ordering one from the certificate authority.',
  noRenewalNeeded: 'Valid.',
  renewalDue: 'Valid, and due for renewal, which the server makes while it runs.',
  expired: 'Expired. The server renews it when it starts.',
  orderFailing: 'No valid certificate: ordering one is failing.',
  cacheUnreadable: "The certificate stored on this device couldn't be read.",
}

/**
 * The tone of the certificate's Status row for each status: only a failing
 * order or an unreadable cache is a failure. A stopped server's certificate
 * lapses and renews when it starts, so `expired` is not one.
 */
const CERTIFICATE_STATUS_TONE: Readonly<
  Record<CertificateState.Status, NonNullable<ItemListItem['tone']>>
> = {
  notIssued: 'neutral',
  ordering: 'neutral',
  noRenewalNeeded: 'neutral',
  renewalDue: 'neutral',
  expired: 'neutral',
  orderFailing: 'danger',
  cacheUnreadable: 'danger',
}

/**
 * What the Last error row says of a run's latest certificate error;
 * `retryHasPassed` is whether a rate limit's retry time has passed.
 */
const certificateErrorText = (
  error: CertificateState.OrderError,
  retryHasPassed: boolean
): string =>
  Match.value(error).pipe(
    Match.when({ kind: 'rateLimited' }, ({ retryAfter }) =>
      retryAfter.pipe(
        Option.map(
          (at) =>
            `The certificate authority's rate limit was reached; it said to retry after ${formatInstant(at)}${retryHasPassed ? '; that time has passed.' : '.'}`
        ),
        Option.getOrElse(() => "The certificate authority's rate limit was reached.")
      )
    ),
    Match.when({ kind: 'challengeFailed' }, ({ detail }) =>
      detail.pipe(
        Option.map(
          (text) => `The certificate authority couldn't validate this server's domain: ${text}`
        ),
        Option.getOrElse(() => "The certificate authority couldn't validate this server's domain.")
      )
    ),
    Match.when(
      { kind: 'caUnreachable' },
      ({ message }) => `The certificate authority couldn't be reached: ${message}`
    ),
    Match.when({ kind: 'other' }, ({ message }) => `Ordering failed: ${message}`),
    Match.when(
      { kind: 'cache' },
      ({ message }) => `The certificates on this device couldn't be read or written: ${message}`
    ),
    Match.exhaustive
  )

/** Where copying the domain to the clipboard stands. */
type CopyOutcome = 'idle' | 'copied' | 'refused'

/**
 * The top of a server's page: its domain, with Copy; its status, merged from
 * its run state and health; when its run started, while it runs; the
 * run-policy field; and Launch.
 *
 * @remarks
 * Launch opens the server's launcher, or says why it can't (see
 * `LaunchButton`). The clipboard needs a focused, secure page and may still
 * refuse; the domain is on screen to copy by hand either way, and the page
 * says so.
 */
const StatusHero = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const status = statusSummary(server.status)
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome>('idle')
  const copyDomain = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(server.domain)
      setCopyOutcome('copied')
    } catch {
      setCopyOutcome('refused')
    }
  }
  return (
    <section className={styles['server-page__hero']} aria-label="Status">
      <div className={styles['server-page__domain-row']}>
        <h2 className={styles['server-page__domain']} title={server.domain}>
          {server.domain}
        </h2>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            void copyDomain()
          }}
        >
          {copyOutcome === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyOutcome === 'refused' ? (
        <p className={`text-body-3 ${styles['server-page__note']}`} role="status">
          The clipboard refused. Select the domain to copy it by hand.
        </p>
      ) : null}
      <div className={styles['server-page__status-row']}>
        <StatusBadge tone={status.tone} pulse={status.tone === 'success'}>
          {status.label}
        </StatusBadge>
        {server.status.runState === 'running' ? (
          <span className={`text-body-3 ${styles['server-page__note']}`}>
            Since {formatInstant(server.status.runningSince)}
          </span>
        ) : null}
      </div>
      <RunPolicyPicker server={server} tone={status.tone} runHostCommand={runHostCommand} />
      <LaunchButton server={server} runHostCommand={runHostCommand} />
    </section>
  )
}

/**
 * What the Connection row says: the host's own check of the server's
 * `/health` through its public origin while a run is in progress, or how
 * its latest run stopped.
 */
const connectionText = (status: ServerStatus.Type): string => {
  if (status.runState === 'stopped') {
    return ServerStatus.lastStopOf(status).pipe(
      Option.map(lastStopText),
      Option.getOrElse(() => "It hasn't run yet.")
    )
  }
  return ServerStatus.healthOf(status).pipe(
    Option.map((health) =>
      health.kind === 'reachable'
        ? `Reachable: its /health answers ${health.status}.`
        : `Not reachable yet: ${health.error}`
    ),
    Option.getOrElse(() =>
      status.runState === 'starting' ? 'Starting.' : 'Checking it can be reached.'
    )
  )
}

/** The rows for how a stopped server's latest run stopped: the platform's reason, and when. */
const lastStopItems = (status: ServerStatus.Type): readonly ItemListItem[] =>
  ServerStatus.lastStopOf(status).pipe(
    Option.map((stop): readonly ItemListItem[] => [
      ...stop.platformReason.pipe(
        Option.map((reason): ItemListItem => ({
          id: 'platform-reason',
          title: 'Platform reason',
          subtitle: PLATFORM_STOP_REASON_TEXT[reason],
        })),
        Option.toArray
      ),
      { id: 'stopped-at', title: 'Stopped', subtitle: formatInstant(stop.stoppedAt) },
    ]),
    Option.getOrElse((): readonly ItemListItem[] => [])
  )

/**
 * The Health report row: the overall status `/health` answered with, or
 * why it couldn't be read, with `actions` at its end.
 */
const healthReportItem = (
  report: UseQueryResult<HealthReport.Type, ServerHealthError>,
  actions: ReactNode
): ItemListItem => {
  const item = { id: 'report', title: 'Health report', actions } as const
  if (report.isPending) return { ...item, subtitle: 'Reading…' }
  if (report.isError) {
    return { ...item, subtitle: `Couldn't read it: ${report.error.message}`, tone: 'danger' }
  }
  return {
    ...item,
    subtitle: `Its /health answers ${report.data.status}.`,
    tone: report.data.status === 'fail' ? 'danger' : 'neutral',
  }
}

/** A row for each check in `report`, by its key, with its status and when it ran. */
const healthCheckItems = (report: HealthReport.Type): readonly ItemListItem[] =>
  Object.entries(report.checks).flatMap(([key, checks]) =>
    checks.map((check, index): ItemListItem => ({
      id: `check-${key}-${String(index)}`,
      title: key,
      meta: check.status,
      subtitle: `Checked ${formatInstant(check.time)}`,
      tone: check.status === 'fail' ? 'danger' : 'neutral',
    }))
  )

/**
 * The server's `/health` report, read by the webview through the relay and
 * the tunnel, once for the run that started at `runningSince`: its overall
 * status and each check, or why it couldn't be read; Refresh reads it again.
 */
const HealthReportList = ({
  domain,
  runningSince,
  runHttpRequest,
}: {
  readonly domain: string
  readonly runningSince: DateTime.Utc
  readonly runHttpRequest: RunHttpRequest
}): JSX.Element => {
  const report = useQuery(serverHealthQueryOptions(runHttpRequest, domain, runningSince))
  const refresh = (
    <button
      type="button"
      className="button-2 outline"
      disabled={report.isFetching}
      onClick={() => {
        void report.refetch()
      }}
    >
      Refresh
    </button>
  )
  return (
    <ItemList
      title="Health checks"
      maxLines={3}
      items={[
        healthReportItem(report, refresh),
        ...(report.isSuccess ? healthCheckItems(report.data) : []),
      ]}
    />
  )
}

/**
 * Whether the host refused a new token because the relay no longer presents
 * the identity the server was added with.
 */
const isRelayIdentityChange = (error: HostCommandError): boolean =>
  error instanceof HostCommandFailed &&
  error.refusal.pipe(Option.exists((refusal) => refusal.kind === 'relayIdentityChanged'))

/**
 * The warning, in place of the host's refusal, that the relay's identity has
 * changed since the server was added: the host's `message`, which names the
 * setting and both values and says the relay may be impersonated, and what
 * to do. It offers no retry, as a token sent again meets the same identity.
 */
const RelayIdentityWarning = ({ message }: { readonly message: string }): JSX.Element => (
  <div className={styles['server-page__identity-warning']} role="alert">
    <p className={`text-label-2 ${styles['server-page__identity-warning-title']}`}>
      The relay's identity has changed
    </p>
    <p className={`text-body-3 ${styles['server-page__identity-warning-detail']}`}>{message}</p>
    <p className="text-body-3">
      If whoever runs the relay confirms it changed, remove this server and add it again.
    </p>
  </div>
)

/**
 * The form that replaces the token the server's tunnel signs in to its
 * relay with. The field starts empty and the stored token is never shown;
 * it clears once the host accepts the new one, and the host's refusal shows
 * under it, or, when the relay's identity has changed, a warning that says
 * so.
 */
const CredentialsForm = ({
  domain,
  runHostCommand,
}: {
  readonly domain: string
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const setCredentials = useSetServerCredentials(runHostCommand)
  const [token, setToken] = useState('')
  return (
    <form
      className={styles['server-page__form']}
      onSubmit={(event) => {
        event.preventDefault()
        setCredentials.mutate(
          { domain, token },
          {
            onSuccess: () => {
              setToken('')
            },
          }
        )
      }}
    >
      <TextField
        label="New tunnel token"
        type="password"
        value={token}
        onChange={setToken}
        autoComplete="off"
        description="The relay checks it before it is saved, and the server starts again with it."
      />
      {setCredentials.error !== null && isRelayIdentityChange(setCredentials.error) ? (
        <RelayIdentityWarning message={failureText(setCredentials.error)} />
      ) : (
        <ErrorBanner
          error={setCredentials.error === null ? null : failureText(setCredentials.error)}
        />
      )}
      <button
        type="submit"
        className={`button-2 outline ${styles['server-page__form-action']}`}
        disabled={token.trim() === '' || setCredentials.isPending}
      >
        Save token
      </button>
    </form>
  )
}

/**
 * The server's connection: as the host last checked it, or how the latest
 * run stopped; and, while the server runs, its `/health` report as the
 * webview reads it.
 */
const Connection = ({
  server,
  runHttpRequest,
}: {
  readonly server: ListedServer.Type
  readonly runHttpRequest: RunHttpRequest
}): JSX.Element => (
  <>
    <ItemList
      title="Connection"
      maxLines={3}
      items={[
        { id: 'connection', title: 'Connection', subtitle: connectionText(server.status) },
        ...lastStopItems(server.status),
      ]}
    />
    {server.status.runState === 'running' ? (
      <HealthReportList
        domain={server.domain}
        runningSince={server.status.runningSince}
        runHttpRequest={runHttpRequest}
      />
    ) : null}
  </>
)

/** The server's relay and tunnel name, and the form that replaces its token. */
const RelayAndTunnel = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => (
  <>
    <ItemList
      title="Relay and tunnel"
      maxLines={3}
      items={[
        { id: 'relay', title: 'Relay', subtitle: relayText(server.relay) },
        { id: 'tunnel-name', title: 'Tunnel name', subtitle: server.tunnelName },
      ]}
    />
    <CredentialsForm domain={server.domain} runHostCommand={runHostCommand} />
  </>
)

/**
 * The server's certificate for its domain: its status; the CA the server
 * orders from, its record's, which Save launcher saves unchanged, and, when
 * the certificate state is for another CA (`issuer`), as before a changed CA
 * takes effect, the CA the state is for; the certificate held, with when it
 * is valid and its fingerprint; and the run's latest error since it last
 * deployed one, `retryHasPassed` saying whether a rate limit's retry time
 * has passed.
 */
const certificateItems = (
  { certificateAuthority, certificate }: ListedServer.Type,
  retryHasPassed: boolean
): readonly ItemListItem[] => [
  {
    id: 'certificate-status',
    title: 'Status',
    subtitle: CERTIFICATE_STATUS_TEXT[certificate.status],
    tone: CERTIFICATE_STATUS_TONE[certificate.status],
  },
  {
    id: 'certificate-authority',
    title: 'Certificate authority',
    subtitle: CERTIFICATE_AUTHORITY_TEXT[certificateAuthority],
  },
  ...(certificate.issuer === certificateAuthority
    ? []
    : [
        {
          id: 'certificate-issuer',
          title: 'State shown for',
          subtitle: CERTIFICATE_AUTHORITY_TEXT[certificate.issuer],
        },
      ]),
  ...certificate.held.pipe(
    Option.map((held): readonly ItemListItem[] => [
      { id: 'valid-from', title: 'Valid from', subtitle: formatInstant(held.notBefore) },
      { id: 'valid-until', title: 'Valid until', subtitle: formatInstant(held.notAfter) },
      { id: 'fingerprint', title: 'SHA-256 fingerprint', subtitle: held.fingerprint },
    ]),
    Option.getOrElse((): readonly ItemListItem[] => [])
  ),
  ...certificate.lastError.pipe(
    Option.map((error): ItemListItem => ({
      id: 'last-error',
      title: 'Last error',
      subtitle: certificateErrorText(error, retryHasPassed),
      tone: 'danger',
    })),
    Option.toArray
  ),
]

/** A URL as the URL parser normalises it, or nothing when it doesn't parse. */
const normalisedUrl = (url: string): Option.Option<string> =>
  URL.canParse(url) ? Option.some(new URL(url).href) : Option.none()

/**
 * Whether `launcherUrl` is `defaultLauncherUrl`, compared as URLs, so a
 * spelling the parser normalises (a host's case, a default port) still
 * matches; a launcher or default that doesn't parse matches nothing.
 */
const isDefaultLauncher = (launcherUrl: string, defaultLauncherUrl: string): boolean =>
  Option.all([normalisedUrl(launcherUrl), normalisedUrl(defaultLauncherUrl)]).pipe(
    Option.exists(([launcher, defaultLauncher]) => launcher === defaultLauncher)
  )

/**
 * The server's Certificate section, rendering again when a rate limit's
 * retry time passes. It shows each row in full (`maxLines={null}`): the
 * fingerprint is compared by hand and a CA's error detail can run long.
 */
const CertificateList = ({ server }: { readonly server: ListedServer.Type }): JSX.Element => {
  const retryHasPassed = useHasPassed(CertificateState.retryAfterOf(server.certificate))
  return (
    <ItemList
      title="Certificate"
      maxLines={null}
      items={certificateItems(server, retryHasPassed)}
    />
  )
}

/**
 * The launcher the server opens apps from: a field starting at the saved
 * URL, Save once it is changed, and, while the saved URL isn't
 * `defaultLauncherUrl`, the one the host gives a new server, compared as
 * URLs, Reset to default, which saves the default at once. The certificate authority is
 * saved unchanged, and the host's refusal shows under the field.
 */
const Launcher = ({
  server,
  defaultLauncherUrl,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly defaultLauncherUrl: string
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const updateLauncher = useUpdateLauncher(runHostCommand)
  const [launcherUrl, setLauncherUrl] = useState(server.launcherUrl)
  const save = (url: string): void => {
    updateLauncher.mutate({
      domain: server.domain,
      launcherUrl: url,
      certificateAuthority: server.certificateAuthority,
    })
  }
  return (
    <form
      className={styles['server-page__form']}
      onSubmit={(event) => {
        event.preventDefault()
        save(launcherUrl)
      }}
    >
      <TextField
        label="Launcher"
        type="url"
        inputMode="url"
        value={launcherUrl}
        onChange={setLauncherUrl}
        description="The page this server's apps are launched from."
      />
      <ErrorBanner
        error={updateLauncher.error === null ? null : failureText(updateLauncher.error)}
      />
      <div className={styles['server-page__form-actions']}>
        <button
          type="submit"
          className={`button-2 outline ${styles['server-page__form-action']}`}
          disabled={launcherUrl === server.launcherUrl || updateLauncher.isPending}
        >
          Save launcher
        </button>
        {isDefaultLauncher(server.launcherUrl, defaultLauncherUrl) ? null : (
          <button
            type="button"
            className={`button-2 ghost ${styles['server-page__form-action']}`}
            disabled={updateLauncher.isPending}
            onClick={() => {
              setLauncherUrl(defaultLauncherUrl)
              save(defaultLauncherUrl)
            }}
          >
            Reset to default
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * The server's removal, said in full under its heading, behind a confirm that asks for its domain to be
 * typed; once removed, the page returns to the list.
 */
const DangerZone = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const headingId = useId()
  const navigate = useNavigate()
  const removeServer = useRemoveServer(runHostCommand, () => {
    void navigate({ to: '/' })
  })
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  return (
    <section className={styles['server-page__section']} aria-labelledby={headingId}>
      <h3 id={headingId} className={`text-label-3 ${styles['server-page__section-title']}`}>
        Danger zone
      </h3>
      <p className={`text-body-3 ${styles['server-page__note']}`}>
        Remove stops this server and deletes it from this device, with its databases and
        certificates. Apps can no longer reach it at this address. It can't be undone.
      </p>
      <ErrorBanner error={removeServer.error === null ? null : failureText(removeServer.error)} />
      <button
        type="button"
        className={`button-2 outline accent-red ${styles['server-page__remove']}`}
        onClick={() => {
          setConfirmingRemoval(true)
        }}
      >
        Remove
      </button>
      <ConfirmDialog
        open={confirmingRemoval}
        title={`Remove ${server.domain}?`}
        confirmLabel="Remove"
        destructive
        pending={removeServer.isPending}
        confirmText={server.domain}
        onConfirm={() => {
          removeServer.mutate(
            { domain: server.domain },
            {
              onSettled: () => {
                setConfirmingRemoval(false)
              },
            }
          )
        }}
        onCancel={() => {
          setConfirmingRemoval(false)
        }}
      >
        This stops the server and deletes it from this device, with its databases and certificates.
        It can't be undone.
      </ConfirmDialog>
    </section>
  )
}

/** The server page's tabs, by their id. */
const TABS = [
  { id: 'status', label: 'Status' },
  { id: 'relay', label: 'Relay' },
  { id: 'certificate', label: 'Certificate' },
] as const

/** The id of one of the server page's {@link TABS}. */
type Tab = (typeof TABS)[number]['id']

/**
 * A server's page, `/servers/$domain`, opened by its card's Edit: its
 * status, with when it runs, over three tabs. Status holds its connection,
 * its `/health` report while it runs, its launcher and its removal; Relay,
 * its relay and tunnel, with a new tunnel token; Certificate, its
 * certificate's state.
 *
 * @remarks
 * The server is read from the same cached list as the server list, kept
 * current by the `server-status` event while the page is open, so a domain
 * the list doesn't hold says so, with the way back. The tab shown is this
 * component's state, opening on Status.
 */
const ServerPage = ({ domain }: { readonly domain: string }): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const runHttpRequest = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHttpRequest,
  })
  const listenToHostEvent = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.listenToHostEvent,
  })
  const defaultLauncherUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.defaultLauncherUrl,
  })
  useServerStatusEvents(listenToHostEvent)
  const tabPanelId = useId()
  const [tab, setTab] = useState<Tab>('status')
  const servers = useQuery(serversQueryOptions(runHostCommand))
  const header = <PageHeader title="Server" subtitle={domain} backHref="/" backLabel="Servers" />
  if (servers.isPending) {
    return (
      <>
        {header}
        <GateCard title="Reading the servers on this device…" />
      </>
    )
  }
  if (servers.isError) {
    return (
      <>
        {header}
        <PageBodyError
          title="The servers on this device couldn't be read"
          error={servers.error}
          retry={() => {
            void servers.refetch()
          }}
        />
      </>
    )
  }
  const server = servers.data.find((listed) => listed.domain === domain)
  if (server === undefined) {
    return (
      <>
        {header}
        <GateCard title="This device has no server at this address." />
      </>
    )
  }
  return (
    <>
      <PageHeader title="Server" backHref="/" backLabel="Servers" />
      <StatusHero server={server} runHostCommand={runHostCommand} />
      <div className={styles['server-page__tabs']} role="tablist" aria-label="Server details">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${tabPanelId}-${id}-tab`}
            aria-selected={tab === id}
            aria-controls={tabPanelId}
            className={`text-label-2 ${styles['server-page__tab']}`}
            onClick={() => {
              setTab(id)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-${tab}-tab`}
        className={styles['server-page__panel']}
      >
        {Match.value(tab).pipe(
          Match.when('status', () => (
            <>
              <Connection server={server} runHttpRequest={runHttpRequest} />
              <Launcher
                server={server}
                defaultLauncherUrl={defaultLauncherUrl}
                runHostCommand={runHostCommand}
              />
              <DangerZone server={server} runHostCommand={runHostCommand} />
            </>
          )),
          Match.when('relay', () => (
            <RelayAndTunnel server={server} runHostCommand={runHostCommand} />
          )),
          Match.when('certificate', () => <CertificateList server={server} />),
          Match.exhaustive
        )}
      </div>
    </>
  )
}

export { ServerPage }
