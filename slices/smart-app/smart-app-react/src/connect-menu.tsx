import { useEffect, useState, type JSX, type SubmitEvent } from 'react'
import { ErrorBanner, TextField } from 'react-tundraish'

import {
  normalizeServerUrl,
  startStandaloneLaunch,
  withLocalNetworkAccessHint,
} from 'fhir-r4-react/smart'
import {
  DEFAULT_SERVER_PRESET_GROUPS,
  hostedServerUrlFor,
  serverPresetGroupsFor,
  wildflowerServerUrlFor,
  WILDFLOWER_DOMAIN,
  type ConnectTarget,
  type ServerPresetGroup,
} from './server-presets.ts'

import styles from './connect-menu.module.css'

/**
 * Props for a {@link ConnectMenu} that launches a SMART app: it connects by
 * Standalone SMART App Launch against a FHIR R4 base.
 *
 * @remarks
 * No `localOrigin`: a SMART app's local server is the desktop host's, at the
 * loopback origin {@link DEFAULT_SERVER_PRESET_GROUPS} is built for.
 */
interface FhirR4ConnectMenuProps {
  readonly target: 'fhir-r4'
  /** The app's registered OAuth client id, passed through to the SMART launch. */
  readonly clientId: string
  /** The scopes the app requests on the SMART path. */
  readonly scope: string
  /**
   * The OAuth redirect target — the app root that serves `index.html` and runs
   * `readySmartClient()`. Shared with the EHR launch's callback.
   */
  readonly redirectUri: string
  /** The one-click choices, grouped by server; defaults to {@link DEFAULT_SERVER_PRESET_GROUPS}. */
  readonly presetGroups?: readonly ServerPresetGroup[]
}

/**
 * Props for a {@link ConnectMenu} that signs the Wildflower owner UI in to a
 * server. The menu picks the server, from the wildflower target's
 * `serverPresetGroupsFor` groups and its entries; the caller runs the sign-in.
 */
interface WildflowerConnectMenuProps {
  readonly target: 'wildflower'
  /**
   * Sign in to the server at `url`, in `normalizeServerUrl`'s canonical form:
   * the server's origin for the local and hosted picks, whatever the reader
   * typed for the free entry, and the FHIR base for the demo server. Which of
   * those it is shows in the URL's shape (an origin, or a FHIR base with a
   * path), so the sign-in reads its FHIR base off the URL (`fhirBaseFor`).
   * Resolves to a problem to show in the menu's error banner, or `undefined`
   * once the page is leaving for the authorization server; a rejection is
   * shown as its message.
   */
  readonly connect: (url: string) => Promise<string | undefined>
  /**
   * The local Wildflower server's origin, e.g. `http://127.0.0.1:8080` — read
   * from the caller's config rather than assumed here.
   */
  readonly localOrigin: string
  /**
   * Whether the page has a sign-in of its own in flight (one it started on
   * arrival, or from a control outside the menu). The menu is disabled while it
   * is, as it is during its own, so a click cannot start a second sign-in over
   * the first.
   */
  readonly busy?: boolean
}

/** Props for {@link ConnectMenu}, discriminated by what it connects: see {@link ConnectTarget}. */
type ConnectMenuProps = FhirR4ConnectMenuProps | WildflowerConnectMenuProps

/**
 * Where the connect flow is: idle, redirecting to a picked server, or showing an
 * error the user can retry from.
 *
 * @remarks
 * A plain `useState` discriminated union — the repo's local-state-machine
 * pattern (see `apps/web-trace`'s `LoadState`). `error` covers an
 * `unreachable` probe, a failed connect and a problem the caller's sign-in
 * reports; all stay retryable because the menu is still rendered underneath
 * the banner. A rejected entry is not a connect state: it is the entry's own,
 * shown beside its form.
 */
type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'launching' }
  | { readonly kind: 'error'; readonly message: string }

/** The words that differ between a SMART app's menu and the owner UI's. */
const MENU_COPY = {
  'fhir-r4': {
    heading: 'Launch with a FHIR server',
    freeEntryName: 'Another FHIR R4 server',
    freeEntryLabel: 'FHIR base URL',
    freeEntryPlaceholder: 'https://example.org/fhir',
    invalidFreeEntry: 'Enter a valid http(s) FHIR base URL, e.g. https://example.org/fhir.',
  },
  wildflower: {
    heading: 'Connect to a server',
    freeEntryName: 'Another Wildflower server',
    freeEntryLabel: 'Server URL',
    freeEntryPlaceholder: 'https://my-server.example.com',
    invalidFreeEntry: 'Enter a valid http(s) server URL, e.g. https://my-server.example.com.',
  },
} as const satisfies Record<ConnectTarget, Record<string, string>>

/** The heading (and form name) of the group that connects to a hosted subdomain. */
const HOSTED_GROUP_NAME = 'Wildflower Health hosted server'

/**
 * The subdomain field's label, naming the domain it is a subdomain of: the
 * `https://` and domain either side of the field are only visual, so the
 * label alone has to say what the field is to a screen reader.
 */
const HOSTED_SUBDOMAIN_LABEL = `Subdomain of ${WILDFLOWER_DOMAIN.slice(1)}`

/**
 * Where the hosted group sits in `presetGroups`: after the leading run of
 * Wildflower servers, so it joins the local server ahead of any other kind.
 */
const hostedGroupIndexIn = (presetGroups: readonly ServerPresetGroup[]): number => {
  const firstOtherServer = presetGroups.findIndex((group) => !group.wildflowerServer)
  return firstOtherServer === -1 ? presetGroups.length : firstOtherServer
}

/**
 * The standalone connect menu: buttons grouped under each known server's name
 * and address, with a subdomain entry for a Wildflower-hosted server slotted
 * in after the Wildflower groups, then, last, a free-entry URL for any other
 * server. What picking one does is the `target`'s: a Standalone SMART App
 * Launch against a FHIR base for `fhir-r4`, the caller's sign-in to an origin
 * for `wildflower`.
 *
 * @remarks
 * The free-entry input is a plain `type="text"` with its own validation via
 * `normalizeServerUrl`: a browser/jsdom `type="url"` runs HTML5 constraint
 * validation that blocks the submit handler before it runs, which would mask our
 * own message. An `unreachable` probe (CORS/network) surfaces as an error with
 * the menu still available to retry — never a silent open-access connection.
 * Whatever the problem, on the published (https) site a loopback pick's reason
 * is followed by the Local Network Access hint (`withLocalNetworkAccessHint`),
 * since Chrome's prompt for it looks like any other network failure.
 *
 * A connect that settles with nothing to show leaves the menu `launching`,
 * its controls disabled: the page is on its way to the authorization server,
 * and a second click in the meantime would start a second sign-in over the
 * first. A page the browser restores from its back-forward cache (the reader
 * pressed Back at the authorization server) comes back `idle`, so the menu
 * is usable again rather than frozen mid-launch. A `wildflower` caller's `busy` disables the menu the same way while a
 * sign-in the page started itself is in flight.
 *
 * Each entry's validation message sits in its own form, beside the field it
 * is about; the banner at the bottom is for what happens after a connect
 * starts.
 *
 * The heading is an `h2`: the menu sits inside an app's landing page, whose
 * `h1` is the app's name.
 */
const ConnectMenu = (props: ConnectMenuProps): JSX.Element => {
  const [state, setState] = useState<ConnectState>({ kind: 'idle' })
  const [hostedSubdomain, setHostedSubdomain] = useState('')
  const [freeEntryUrl, setFreeEntryUrl] = useState('')
  const [hostedProblem, setHostedProblem] = useState<string | undefined>(undefined)
  const [freeEntryProblem, setFreeEntryProblem] = useState<string | undefined>(undefined)

  // A launch leaves the page `launching`; Back from the authorization server
  // can restore it from the back-forward cache exactly as it was, controls
  // disabled. Start over instead.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) setState({ kind: 'idle' })
    }
    window.addEventListener('pageshow', onPageShow)
    return (): void => {
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  const launching =
    state.kind === 'launching' || (props.target === 'wildflower' && props.busy === true)
  const copy = MENU_COPY[props.target]
  const presetGroups =
    props.target === 'fhir-r4'
      ? (props.presetGroups ?? DEFAULT_SERVER_PRESET_GROUPS)
      : serverPresetGroupsFor('wildflower', props.localOrigin)
  const hostedGroupIndex = hostedGroupIndexIn(presetGroups)

  /**
   * Connect to `serverUrl` the target's way, resolving to a problem to show or
   * `undefined` once the page is leaving.
   */
  const startConnecting = (serverUrl: string): Promise<string | undefined> =>
    props.target === 'fhir-r4'
      ? startStandaloneLaunch({
          iss: serverUrl,
          clientId: props.clientId,
          scope: props.scope,
          redirectUri: props.redirectUri,
        }).then((support) =>
          // `smart`/`open` redirect the page away, so only `unreachable` (or
          // the rare case a redirect did not navigate) is left to report.
          support.kind === 'unreachable'
            ? `Could not reach ${serverUrl}. Check the URL and that the server allows this app. (${support.message})`
            : undefined
        )
      : props.connect(serverUrl)

  const connectTo = (serverUrl: string): void => {
    setHostedProblem(undefined)
    setFreeEntryProblem(undefined)
    setState({ kind: 'launching' })
    // Read when the pick is made, not at import: whether this page is the
    // published (https) one decides if a loopback failure needs the Local
    // Network Access hint after its reason.
    const pageIsSecure = window.location.protocol === 'https:'
    const reportProblem = (reason: string): void => {
      setState({
        kind: 'error',
        message: withLocalNetworkAccessHint(reason, serverUrl, { pageIsSecure }),
      })
    }
    startConnecting(serverUrl)
      .then((problem) => {
        if (problem !== undefined) reportProblem(problem)
      })
      .catch((error: unknown) => {
        reportProblem(error instanceof Error ? error.message : String(error))
      })
  }

  const onHostedSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const hostedUrl = hostedServerUrlFor(props.target, hostedSubdomain)
    if (hostedUrl === undefined) {
      setHostedProblem(
        "Enter your server's subdomain: letters, digits and hyphens, with dots between parts, e.g. my-server."
      )
      return
    }
    connectTo(hostedUrl)
  }

  const onFreeEntrySubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalized = normalizeServerUrl(freeEntryUrl)
    if (normalized === undefined) {
      setFreeEntryProblem(copy.invalidFreeEntry)
      return
    }
    connectTo(normalized)
  }

  const presetGroup = (group: ServerPresetGroup): JSX.Element => (
    <section key={group.name} className={styles['group']} aria-label={group.name}>
      <h3 className={styles['group__name']}>{group.name}</h3>
      <span className={styles['group__address']}>{group.address}</span>
      {group.notice === undefined ? null : (
        <p className={styles['group__notice']}>{group.notice}</p>
      )}
      <div className={styles['group__presets']}>
        {group.presets.map((preset) => (
          <button
            key={preset.url}
            type="button"
            className="button-2"
            disabled={launching}
            onClick={(): void => {
              connectTo(preset.url)
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  )

  return (
    <section className={styles['connect']}>
      <h2 className={styles['connect__heading']}>{copy.heading}</h2>

      {presetGroups.slice(0, hostedGroupIndex).map(presetGroup)}

      <form className={styles['group']} onSubmit={onHostedSubmit} aria-label={HOSTED_GROUP_NAME}>
        <h3 className={styles['group__name']}>{HOSTED_GROUP_NAME}</h3>
        <div className={styles['hosted']}>
          <span className={styles['hosted__scheme']}>https://</span>
          <div className={styles['hosted__subdomain']}>
            <TextField
              label={HOSTED_SUBDOMAIN_LABEL}
              type="text"
              inputMode="url"
              value={hostedSubdomain}
              onChange={setHostedSubdomain}
              placeholder="my-server"
              disabled={launching}
              className={styles['hosted__input']}
            />
          </div>
          <span className={styles['hosted__domain']}>
            {wildflowerServerUrlFor(props.target, WILDFLOWER_DOMAIN)}
          </span>
        </div>
        <ErrorBanner error={hostedProblem} />
        <div className={styles['actions']}>
          <button type="submit" className="button-2" disabled={launching}>
            Connect
          </button>
        </div>
      </form>

      {presetGroups.slice(hostedGroupIndex).map(presetGroup)}

      <form
        className={styles['group']}
        onSubmit={onFreeEntrySubmit}
        aria-label={copy.freeEntryName}
      >
        <h3 className={styles['group__name']}>{copy.freeEntryName}</h3>
        <TextField
          label={copy.freeEntryLabel}
          type="text"
          value={freeEntryUrl}
          onChange={setFreeEntryUrl}
          placeholder={copy.freeEntryPlaceholder}
          disabled={launching}
        />
        <ErrorBanner error={freeEntryProblem} />
        <div className={styles['actions']}>
          <button type="submit" className="button-2" disabled={launching}>
            Connect
          </button>
        </div>
      </form>

      {state.kind === 'error' && (
        <div className={styles['error']}>
          <ErrorBanner error={state.message} />
        </div>
      )}
    </section>
  )
}

export {
  ConnectMenu,
  type ConnectMenuProps,
  type FhirR4ConnectMenuProps,
  type WildflowerConnectMenuProps,
}
