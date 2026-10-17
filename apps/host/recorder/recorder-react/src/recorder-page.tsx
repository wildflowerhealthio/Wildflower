import { formatRelativeTime } from '@wildflowerhealthio/kitchen-sink'
import {
  ErrorBanner,
  FieldDescription,
  PageHeader,
  pageLayoutStyles,
  TextField,
} from '@wildflowerhealthio/react-tundraish'
import {
  type Bookmark,
  bookmarkUrl,
  byRecency,
  HttpUrl,
  type InvokeHostCommand,
} from '@wildflowerhealthio/recorder-core-js'
import { DateTime, Match, Option, Schema } from 'effect'
import { useId, useState, type JSX } from 'react'

import { useProvidedRecorder } from './recorder-context.ts'
import { type BookmarkChange, type Bookmarks, useBookmarks } from './use-bookmarks.ts'
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

/** Props for {@link RecorderPage}. */
interface RecorderPageProps {
  /** How the page reads the recordings folder and the bookmarks: Tauri's `invoke`. */
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

/** A bookmark's name, being typed: Save sends it, Cancel drops it. */
function BookmarkNameForm({
  label,
  initialName,
  disabled,
  onSave,
  onCancel,
}: {
  readonly label: string
  readonly initialName: string
  /** Whether a bookmark change is waiting on the host. */
  readonly disabled: boolean
  readonly onSave: (name: string) => void
  readonly onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(initialName)
  const trimmedName = name.trim()
  return (
    <form
      className={styles['recorder-page__bookmark-form']}
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmedName !== '') onSave(trimmedName)
      }}
    >
      <TextField label={label} value={name} onChange={setName} autoCapitalize="words" />
      <div className={styles['recorder-page__buttons']}>
        <button type="submit" className="button-2 filled" disabled={disabled || trimmedName === ''}>
          Save
        </button>
        <button type="button" className="button-2" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** When a recording last started from `bookmark`, as its row says it. */
const lastRecordedText = (bookmark: Bookmark, now: DateTime.DateTime): string =>
  Option.fromNullable(bookmark.lastRecordedAt).pipe(
    Option.map((recordedAt) => `last recorded ${formatRelativeTime(recordedAt, now)}`),
    Option.getOrElse(() => 'never recorded')
  )

/** One bookmark: its name fills the URL field; Rename and Remove change it. */
function BookmarkRow({
  bookmark,
  now,
  canPick,
  isChanging,
  onPick,
  onRename,
  onRemove,
}: {
  readonly bookmark: Bookmark
  readonly now: DateTime.DateTime
  /** Whether the URL field takes a URL now: not while recording or saving. */
  readonly canPick: boolean
  readonly isChanging: boolean
  readonly onPick: (url: string) => void
  /** Rename the bookmark; whether the host took the change. */
  readonly onRename: (name: string) => Promise<boolean>
  readonly onRemove: () => void
}): JSX.Element {
  const [isRenaming, setIsRenaming] = useState(false)
  return (
    <li className={styles['recorder-page__bookmark']}>
      <button
        type="button"
        className={`button-2 ${styles['recorder-page__bookmark-name']}`}
        disabled={!canPick}
        onClick={() => onPick(bookmark.url)}
      >
        {bookmark.name}
      </button>
      <span className={styles['recorder-page__path']}>{bookmark.url}</span>
      <span className={`text-body-3 ${styles['recorder-page__bookmark-meta']}`}>
        {lastRecordedText(bookmark, now)}
      </span>
      {isRenaming ? (
        <BookmarkNameForm
          label={`New name for ${bookmark.name}`}
          initialName={bookmark.name}
          disabled={isChanging}
          onSave={(name) => {
            void onRename(name).then((renamed) => {
              if (renamed) setIsRenaming(false)
            })
          }}
          onCancel={() => setIsRenaming(false)}
        />
      ) : (
        <div className={styles['recorder-page__buttons']}>
          <button
            type="button"
            className="button-3 outline"
            disabled={isChanging}
            aria-label={`Rename ${bookmark.name}`}
            onClick={() => setIsRenaming(true)}
          >
            Rename
          </button>
          <button
            type="button"
            className="button-3 outline accent-red"
            disabled={isChanging}
            aria-label={`Remove ${bookmark.name}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      )}
    </li>
  )
}

/** The bookmarks, most recently recorded first, or why the host can't give them. */
function BookmarksSection({
  bookmarks,
  canPick,
  onPick,
  runChange,
}: {
  readonly bookmarks: Bookmarks
  readonly canPick: boolean
  readonly onPick: (url: string) => void
  /** Send a change, showing a refusal; whether the host took it. */
  readonly runChange: (change: BookmarkChange) => Promise<boolean>
}): JSX.Element {
  const headingId = useId()
  const now = DateTime.unsafeNow()
  return (
    <section className={styles['recorder-page__bookmarks']} aria-labelledby={headingId}>
      <h2 id={headingId} className="text-heading-4">
        Bookmarks
      </h2>
      {Match.value(bookmarks.state).pipe(
        Match.tag('Reading', () => (
          <p className={styles['recorder-page__folder']}>Reading the bookmarks…</p>
        )),
        Match.tag('Read', ({ bookmarks: read }) =>
          read.length === 0 ? (
            <p className={styles['recorder-page__folder']}>No bookmarks yet.</p>
          ) : (
            <ul className={styles['recorder-page__bookmark-list']}>
              {byRecency(read).map((bookmark) => (
                <BookmarkRow
                  key={bookmark.url}
                  bookmark={bookmark}
                  now={now}
                  canPick={canPick}
                  isChanging={bookmarks.isChanging}
                  onPick={onPick}
                  onRename={(name) => runChange(bookmarks.rename(bookmark.url, name))}
                  onRemove={() => {
                    void runChange(bookmarks.remove(bookmark.url))
                  }}
                />
              ))}
            </ul>
          )
        ),
        Match.tag('Unreadable', ({ message }) => (
          <p className={styles['recorder-page__folder']} role="alert">
            Bookmarks can't be read on this device: {message}
          </p>
        )),
        Match.exhaustive
      )}
    </section>
  )
}

/**
 * The URL field's URL as a bookmark's key, when it is one the page can
 * bookmark: startable, and not bookmarked yet.
 */
const unbookmarkedUrlOf = (url: string, bookmarks: Bookmarks): Option.Option<string> =>
  Option.liftPredicate(url, isStartableUrl).pipe(
    Option.flatMap(bookmarkUrl),
    Option.filter(
      (key) =>
        bookmarks.state._tag === 'Read' &&
        !bookmarks.state.bookmarks.some((bookmark) => bookmark.url === key)
    )
  )

/**
 * The Recorder page: type a URL or pick a bookmark, record the responses the
 * sniffer webview reports, and save them as a `.har` file in the recordings
 * folder, which the page shows. After a save it offers Show file where the
 * platform's file manager can reveal one. Its bookmarks, most recently
 * recorded first, say when each was last recorded; a startable URL that isn't
 * bookmarked can be, and starting a recording stamps the bookmark at exactly
 * that URL.
 *
 * @remarks
 * Needs a `RecorderProvider` above it. The page is only the state machine's
 * face — the provider's `useRecorder` owns the recording, the ordering and the
 * bridge, so a recording outlives the page; a page that mounts mid-recording
 * shows the URL being recorded.
 */
function RecorderPage({ invoke, revealFile }: RecorderPageProps): JSX.Element {
  const { state, start, stop } = useProvidedRecorder()
  const [url, setUrl] = useState(state._tag === 'Recording' ? state.startUrl : '')
  const saveFolder = useSaveFolder(invoke)
  const bookmarks = useBookmarks(invoke)
  const [revealFailure, setRevealFailure] = useState<string | null>(null)
  const [bookmarkFailure, setBookmarkFailure] = useState<string | null>(null)
  const [isNamingBookmark, setIsNamingBookmark] = useState(false)
  const revealsFiles = saveFolder._tag === 'Read' && saveFolder.folder.revealsFiles

  const isRecording = state._tag === 'Recording'
  // `Saving` blocks a new recording: starting again would re-point the file
  // name the host's pending answer is matched on.
  const takesUrl = state._tag !== 'Recording' && state._tag !== 'Saving'
  const canStart = takesUrl && isStartableUrl(url)
  const unbookmarkedUrl = canStart ? unbookmarkedUrlOf(url, bookmarks) : Option.none()

  /** Send a bookmark change, showing its refusal in the banner; whether the host took it. */
  const runChange = (change: BookmarkChange): Promise<boolean> => {
    setBookmarkFailure(null)
    return change.then(
      Option.match({
        onNone: () => true,
        onSome: ({ message }) => {
          setBookmarkFailure(message)
          return false
        },
      })
    )
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <PageHeader title="Recorder" />

      <FieldDescription>
        Opens the page in the recorder window and keeps every fetch/XHR response it reports. Closing
        that window saves the recording, just like Stop &amp; Save.
      </FieldDescription>

      <SaveFolderLine saveFolder={saveFolder} />

      <ErrorBanner error={state._tag === 'Failed' ? state.message : revealFailure} />
      <ErrorBanner error={bookmarkFailure} />

      <TextField
        label="URL"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        placeholder="https://example.com"
        value={url}
        onChange={setUrl}
        disabled={!takesUrl}
      />

      <BookmarksSection
        bookmarks={bookmarks}
        canPick={takesUrl}
        onPick={(bookmarkedUrl) => {
          setIsNamingBookmark(false)
          setUrl(bookmarkedUrl)
        }}
        runChange={runChange}
      />

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
          <p className={styles['recorder-page__status']} role="status">
            Saved to <span className={styles['recorder-page__path']}>{s.path}</span>
          </p>
        )),
        Match.orElse(() => null)
      )}

      <div className={styles['recorder-page__buttons']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={!canStart}
          onClick={() => {
            setRevealFailure(null)
            setIsNamingBookmark(false)
            start(url)
            // Stamps the bookmark at exactly this URL, if there is one. With
            // bookmarks the host can't read, the stamp would only fail again.
            const recordedUrl = bookmarkUrl(url)
            if (bookmarks.state._tag !== 'Unreadable' && Option.isSome(recordedUrl)) {
              void runChange(bookmarks.recorded(recordedUrl.value))
            }
          }}
        >
          Start recording
        </button>
        {isRecording ? (
          <button type="button" className="button-2" onClick={stop}>
            Stop &amp; Save
          </button>
        ) : null}
        {state._tag === 'Saved' && revealsFiles ? (
          <button
            type="button"
            className="button-2"
            onClick={() => {
              setRevealFailure(null)
              revealFile(state.path).catch((error: unknown) => {
                setRevealFailure(
                  `The file couldn't be shown: ${error instanceof Error ? error.message : String(error)}`
                )
              })
            }}
          >
            Show file
          </button>
        ) : null}
        {unbookmarkedUrl.pipe(
          Option.filter(() => !isNamingBookmark),
          Option.map(() => (
            <button
              key="bookmark-this"
              type="button"
              className="button-2"
              disabled={bookmarks.isChanging}
              onClick={() => setIsNamingBookmark(true)}
            >
              Bookmark this
            </button>
          )),
          Option.getOrNull
        )}
      </div>

      {unbookmarkedUrl.pipe(
        Option.filter(() => isNamingBookmark),
        Option.map((key) => (
          <BookmarkNameForm
            key={key}
            label="Bookmark name"
            initialName={new URL(key).host}
            disabled={bookmarks.isChanging}
            onSave={(name) => {
              void runChange(bookmarks.add(name, key)).then((added) => {
                if (added) setIsNamingBookmark(false)
              })
            }}
            onCancel={() => setIsNamingBookmark(false)}
          />
        )),
        Option.getOrNull
      )}
    </div>
  )
}

export { RecorderPage, type RecorderPageProps }
