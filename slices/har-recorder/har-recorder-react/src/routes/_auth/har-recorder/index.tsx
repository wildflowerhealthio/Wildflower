import { createFileRoute } from '@tanstack/react-router'
import { WebViewSource } from 'collector-fundamentals/model'
import { Match, Schema } from 'effect'
import { useId, useState, type JSX } from 'react'
import { ErrorBanner, FieldDescription, PageHeader, TextField } from 'react-tundraish'

import { useHarRecorder } from '../../../use-har-recorder.ts'
import styles from './har-recorder.module.css'

/**
 * Does this string name a page the sniffer will open?
 *
 * @remarks
 * The collector's own `HttpUriString` — what the `Open` message's `uri` decodes
 * against — rather than a second URL rule, so Start is disabled on exactly the
 * inputs the wire would refuse.
 */
const isStartableUrl = Schema.is(WebViewSource.HttpUriString)

const SUGGESTED_URLS: readonly string[] = [
  'https://app.letsbewell.ca/health/prescriptions',
  'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/',
  'https://www.on.mycarecompass.lifelabs.com/reports',
  'https://virtualcare.telushealth.com/',
]

/**
 * The HAR Recorder page: type a URL, record the responses the sniffer webview
 * reports, and save them as a `.har` file in the app's `saved_data` directory.
 *
 * @remarks
 * Desktop-only: the Tauri entry contributes the tab via `platformTabs`, because
 * the sniffer webview and the filesystem write both live in the host. The page
 * is only the state machine's face — {@link useHarRecorder} owns the recording,
 * the ordering and the two bridges.
 */
function HarRecorderPage(): JSX.Element {
  const [url, setUrl] = useState('')
  const { state, start, stop } = useHarRecorder()
  const suggestionsId = useId()

  const isRecording = state._tag === 'Recording'
  // `Saving` blocks a new recording: starting again would re-point the file
  // name the host's pending answer is matched on.
  const canStart = state._tag !== 'Recording' && state._tag !== 'Saving' && isStartableUrl(url)

  return (
    <>
      <PageHeader title="HAR Recorder" />

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

      <div className={styles['buttons']}>
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
          <p className={styles['status']} role="status">
            {s.count} {s.count === 1 ? 'response' : 'responses'} recorded
          </p>
        )),
        Match.when({ _tag: 'Saving' }, (s) => (
          <p className={styles['status']} role="status">
            Saving {s.fileName}…
          </p>
        )),
        Match.when({ _tag: 'Saved' }, (s) => (
          <p className={styles['path']} role="status">
            Saved to {s.path}
          </p>
        )),
        Match.orElse(() => null)
      )}
    </>
  )
}

const Route = createFileRoute('/_auth/har-recorder/')({
  component: HarRecorderPage,
})

export { HarRecorderPage, Route }
