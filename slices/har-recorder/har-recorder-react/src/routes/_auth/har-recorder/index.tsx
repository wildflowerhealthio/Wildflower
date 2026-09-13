import { createFileRoute } from '@tanstack/react-router'
import { WebViewSource } from 'collector-fundamentals/model'
import { Schema } from 'effect'
import { useState, type JSX } from 'react'
import { ErrorBanner, FieldDescription, PageHeader, TextField } from 'react-tundraish'

import { useHarRecorder } from '../../../use-har-recorder.ts'
import styles from './har-recorder.module.css'

/**
 * Does this string name a page the sniffer will open?
 *
 * @remarks
 * The collector's own `HttpUriString` — the refinement the `Open` message's
 * `uri` is decoded against — rather than a second URL rule here. A URL this
 * rejects would fail to decode at the bridge boundary and never reach the
 * host, so the Start button is disabled on exactly the inputs the wire refuses.
 */
const isStartableUrl = Schema.is(WebViewSource.HttpUriString)

/**
 * The HAR Recorder page: type a URL, record the responses the sniffer webview
 * reports, and save them as a `.har` file in the app's `saved_data` directory.
 *
 * @remarks
 * A desktop-only surface — it is reached through the Tauri shell's own tab (the
 * entry contributes it via `platformTabs`), because the sniffer webview and the
 * filesystem write both live in the host. The page itself is only the state
 * machine's face: {@link useHarRecorder} owns the recording, the ordering, and
 * the two bridges.
 */
function HarRecorderPage(): JSX.Element {
  const [url, setUrl] = useState('')
  const { state, start, stop } = useHarRecorder()

  const isRecording = state._tag === 'Recording'
  // `Saving` is the one state a new recording must not start from: its archive
  // is still with the host, and starting again would re-point the file name the
  // pending answer is matched on.
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
        value={url}
        onChange={setUrl}
        disabled={isRecording || state._tag === 'Saving'}
      />

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

      {state._tag === 'Recording' ? (
        <p className={styles['status']} role="status">
          {state.count} {state.count === 1 ? 'response' : 'responses'} recorded
        </p>
      ) : null}

      {state._tag === 'Saving' ? (
        <p className={styles['status']} role="status">
          Saving {state.fileName}…
        </p>
      ) : null}

      {state._tag === 'Saved' ? (
        <p className={styles['path']} role="status">
          Saved to {state.path}
        </p>
      ) : null}
    </>
  )
}

const Route = createFileRoute('/_auth/har-recorder/')({
  component: HarRecorderPage,
})

export { HarRecorderPage, Route }
