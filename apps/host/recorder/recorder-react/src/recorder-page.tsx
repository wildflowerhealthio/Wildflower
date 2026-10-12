import {
  ErrorBanner,
  FieldDescription,
  PageHeader,
  pageLayoutStyles,
  TextField,
} from '@wildflowerhealthio/react-tundraish'
import { HttpUrl, type InvokeHostCommand } from '@wildflowerhealthio/recorder-core-js'
import { Match, Schema } from 'effect'
import { useId, useState, type JSX } from 'react'

import { useRecorder } from './use-recorder.ts'
import { type SaveFolderState, useSaveFolder } from './use-save-folder.ts'
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

/** Props for {@link RecorderPage}. */
interface RecorderPageProps {
  /** How the page reads the recordings folder: Tauri's `invoke`. */
  readonly invoke: InvokeHostCommand
  /**
   * Show a saved file selected in the platform's file manager:
   * `tauri-plugin-opener`'s `revealItemInDir`. Offered only where the host
   * says the platform can.
   */
  readonly revealFile: (path: string) => Promise<void>
}

/** Where recordings go, or why the host can't say. */
function SaveFolderLine({ saveFolder }: { readonly saveFolder: SaveFolderState }): JSX.Element {
  return Match.value(saveFolder).pipe(
    Match.tag('Reading', () => (
      <p className={styles['recorder-page__folder']}>Finding the recordings folder…</p>
    )),
    Match.tag('Read', ({ folder }) => (
      <p className={styles['recorder-page__folder']}>
        Recordings are saved to <span className={styles['recorder-page__path']}>{folder.path}</span>
      </p>
    )),
    Match.tag('Unreadable', ({ message }) => (
      <p className={styles['recorder-page__folder']} role="alert">
        Recordings can't be saved on this device: {message}
      </p>
    )),
    Match.exhaustive
  )
}

/**
 * The Recorder page: type a URL, record the responses the sniffer webview
 * reports, and save them as a `.har` file in the recordings folder, which the
 * page shows. After a save it offers Show file where the platform's file
 * manager can reveal one.
 *
 * @remarks
 * Needs a `RecorderSenderProvider` and a `HandlerCoordinatorContext`
 * above it, both over the app's `RecorderBridge` transport. The page is only
 * the state machine's face — {@link useRecorder} owns the recording, the
 * ordering and the bridge.
 */
function RecorderPage({ invoke, revealFile }: RecorderPageProps): JSX.Element {
  const [url, setUrl] = useState('')
  const { state, start, stop } = useRecorder()
  const saveFolder = useSaveFolder(invoke)
  const [revealFailure, setRevealFailure] = useState<string | null>(null)
  const suggestionsId = useId()
  const revealsFiles = saveFolder._tag === 'Read' && saveFolder.folder.revealsFiles

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

      <SaveFolderLine saveFolder={saveFolder} />

      <ErrorBanner error={state._tag === 'Failed' ? state.message : revealFailure} />

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
            setRevealFailure(null)
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
          <>
            <p className={styles['recorder-page__status']} role="status">
              Saved to <span className={styles['recorder-page__path']}>{s.path}</span>
            </p>
            {revealsFiles ? (
              <div className={styles['recorder-page__buttons']}>
                <button
                  type="button"
                  className="button-2"
                  onClick={() => {
                    setRevealFailure(null)
                    revealFile(s.path).catch((error: unknown) => {
                      setRevealFailure(
                        `The file couldn't be shown: ${error instanceof Error ? error.message : String(error)}`
                      )
                    })
                  }}
                >
                  Show file
                </button>
              </div>
            ) : null}
          </>
        )),
        Match.orElse(() => null)
      )}
    </div>
  )
}

export { RecorderPage, type RecorderPageProps }
