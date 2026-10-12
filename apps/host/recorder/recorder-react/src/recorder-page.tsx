import {
  ErrorBanner,
  FieldDescription,
  PageHeader,
  pageLayoutStyles,
  TextField,
} from '@wildflowerhealthio/react-tundraish'
import { HttpUrl } from '@wildflowerhealthio/recorder-core-js'
import { Match, Schema } from 'effect'
import { useId, useState, type JSX } from 'react'

import { useRecorder } from './use-recorder.ts'
import styles from './recorder-page.module.css'

/**
 * Does this string name a page the sniffer will open?
 *
 * @remarks
 * The `Open` message's own URL schema rather than a second URL rule, so Start
 * is disabled on exactly the inputs the wire would refuse.
 */
const isStartableUrl = Schema.is(HttpUrl)

const SUGGESTED_URLS: readonly string[] = [
  'https://app.letsbewell.ca/health/prescriptions',
  'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/',
  'https://www.on.mycarecompass.lifelabs.com/reports',
  'https://virtualcare.telushealth.com/',
]

/**
 * The Recorder page: type a URL, record the responses the sniffer webview
 * reports, and save them as a `.har` file.
 *
 * @remarks
 * Needs a `RecorderSenderProvider` and a `HandlerCoordinatorContext`
 * above it, both over the app's `RecorderBridge` transport. The page is only
 * the state machine's face — {@link useRecorder} owns the recording, the
 * ordering and the bridge.
 */
function RecorderPage(): JSX.Element {
  const [url, setUrl] = useState('')
  const { state, start, stop } = useRecorder()
  const suggestionsId = useId()

  const isRecording = state._tag === 'Recording'
  // `Saving` blocks a new recording: starting again would re-point the file
  // name the host's pending answer is matched on.
  const canStart = state._tag !== 'Recording' && state._tag !== 'Saving' && isStartableUrl(url)

  return (
    <div className={pageLayoutStyles['page']}>
      <PageHeader title="Recorder" />

      <FieldDescription>
        Opens the page in the recorder window and keeps every fetch/XHR response it reports. Closing
        that window saves the recording, just like Stop &amp; Save.
      </FieldDescription>

      <ErrorBanner error={state._tag === 'Failed' ? state.message : null} />

      <TextField
        label="URL"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        placeholder="https://example.com"
        list={suggestionsId}
        value={url}
        onChange={setUrl}
        disabled={isRecording || state._tag === 'Saving'}
      />
      <datalist id={suggestionsId}>
        {SUGGESTED_URLS.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>

      <div className={styles['recorder-page__buttons']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={!canStart}
          onClick={() => {
            start(url)
          }}
        >
          Start recording
        </button>
        {isRecording ? (
          <button type="button" className="button-2" onClick={stop}>
            Stop &amp; Save
          </button>
        ) : null}
      </div>

      {Match.value(state).pipe(
        Match.when({ _tag: 'Recording' }, (s) => (
          <p className={styles['recorder-page__status']} role="status">
            {s.count} {s.count === 1 ? 'response' : 'responses'} recorded
          </p>
        )),
        Match.when({ _tag: 'Saving' }, (s) => (
          <p className={styles['recorder-page__status']} role="status">
            Saving {s.fileName}…
          </p>
        )),
        Match.when({ _tag: 'Saved' }, (s) => (
          <p className={styles['recorder-page__path']} role="status">
            Saved to {s.path}
          </p>
        )),
        Match.orElse(() => null)
      )}
    </div>
  )
}

export { RecorderPage }
