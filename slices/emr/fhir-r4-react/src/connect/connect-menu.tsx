import { useState, type JSX, type SubmitEvent } from 'react'
import { ErrorBanner, TextField } from 'react-tundraish'

import { normalizeServerUrl, startStandaloneLaunch } from '../smart/standalone-launch.ts'
import { DEFAULT_SERVER_PRESETS, type ServerPreset } from './server-presets.ts'

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
  /** The one-click choices; defaults to {@link DEFAULT_SERVER_PRESETS}. */
  readonly presets?: readonly ServerPreset[]
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
 * The standalone connect menu: pick a FHIR server (a preset or a typed URL) and
 * start a Standalone SMART App Launch against it.
 *
 * @remarks
 * The free-entry input is a plain `type="text"` with its own validation via
 * `normalizeServerUrl`: a browser/jsdom `type="url"` runs HTML5 constraint
 * validation that blocks the submit handler before it runs, which would mask our
 * own message. An `unreachable` probe (CORS/network) surfaces as an error with
 * the menu still available to retry — never a silent open-access connection.
 */
const ConnectMenu = ({
  clientId,
  scope,
  redirectUri,
  presets = DEFAULT_SERVER_PRESETS,
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
        message: 'Enter a valid http(s) FHIR server URL, e.g. https://example.org/fhir.',
      })
      return
    }
    connectTo(normalized)
  }

  return (
    <section className={styles['connect']}>
      <h1 className="text-heading-3">Connect to a FHIR server</h1>

      <div className={styles['presets']}>
        {presets.map((preset) => (
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

      <form className={styles['form']} onSubmit={onSubmit}>
        <TextField
          label="FHIR server URL"
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

      {state.kind === 'error' && <ErrorBanner error={state.message} />}
    </section>
  )
}

export { ConnectMenu, type ConnectMenuProps }
