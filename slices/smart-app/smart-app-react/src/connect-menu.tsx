import { useState, type JSX, type SubmitEvent } from 'react'
import { ErrorBanner, TextField } from 'react-tundraish'

import { normalizeServerUrl, startStandaloneLaunch } from 'fhir-r4-react/smart'
import { DEFAULT_SERVER_PRESET_GROUPS, type ServerPresetGroup } from './server-presets.ts'

import styles from './connect-menu.module.css'

/** Props for {@link ConnectMenu}. */
interface ConnectMenuProps {
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
 * Where the connect flow is: idle, redirecting to a picked server, or showing an
 * error the user can retry from.
 *
 * @remarks
 * A plain `useState` discriminated union — the repo's local-state-machine
 * pattern (see `apps/web-trace`'s `LoadState`). `error` covers both a rejected
 * free-entry validation and an `unreachable` probe; both stay retryable because
 * the menu is still rendered underneath the banner.
 */
type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'launching' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * The standalone connect menu: launch buttons grouped under each known server's
 * name and address, then, last, a free-entry URL for any other server. Picking one starts a
 * Standalone SMART App Launch against it.
 *
 * @remarks
 * The free-entry input is a plain `type="text"` with its own validation via
 * `normalizeServerUrl`: a browser/jsdom `type="url"` runs HTML5 constraint
 * validation that blocks the submit handler before it runs, which would mask our
 * own message. An `unreachable` probe (CORS/network) surfaces as an error with
 * the menu still available to retry — never a silent open-access connection.
 *
 * The heading is an `h2`: the menu sits inside an app's landing page, whose
 * `h1` is the app's name.
 */
const ConnectMenu = ({
  clientId,
  scope,
  redirectUri,
  presetGroups = DEFAULT_SERVER_PRESET_GROUPS,
}: ConnectMenuProps): JSX.Element => {
  const [state, setState] = useState<ConnectState>({ kind: 'idle' })
  const [url, setUrl] = useState('')

  const launching = state.kind === 'launching'

  const connectTo = (iss: string): void => {
    setState({ kind: 'launching' })
    startStandaloneLaunch({ iss, clientId, scope, redirectUri })
      .then((support) => {
        // `smart`/`open` redirect the page away, so this arm only runs for
        // `unreachable` (or the rare case a redirect did not navigate).
        if (support.kind === 'unreachable') {
          setState({
            kind: 'error',
            message: `Could not reach ${iss}. Check the URL and that the server allows this app. (${support.message})`,
          })
        }
      })
      .catch((error: unknown) => {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalized = normalizeServerUrl(url)
    if (normalized === undefined) {
      setState({
        kind: 'error',
        message: 'Enter a valid http(s) FHIR base URL, e.g. https://example.org/fhir.',
      })
      return
    }
    connectTo(normalized)
  }

  return (
    <section className={styles['connect']}>
      <h2 className={styles['connect__heading']}>Launch with a FHIR server</h2>

      {presetGroups.map((group) => (
        <section key={group.name} className={styles['group']} aria-label={group.name}>
          <h3 className={styles['group__name']}>{group.name}</h3>
          <span className={styles['group__address']}>{group.address}</span>
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
      ))}

      <form className={styles['group']} onSubmit={onSubmit} aria-label="Another FHIR R4 server">
        <h3 className={styles['group__name']}>Another FHIR R4 server</h3>
        <TextField
          label="FHIR base URL"
          type="text"
          value={url}
          onChange={setUrl}
          placeholder="https://example.org/fhir"
          disabled={launching}
        />
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

export { ConnectMenu, type ConnectMenuProps }
