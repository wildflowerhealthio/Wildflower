import { DateTime } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import { useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react'

import { fetchHarArchive, useHarArchivesQuery } from '../queries/har-archives.ts'
import { acceptLocalHar, type ReadableFile } from './local-har.ts'
import type { PickedHar } from './picked-har.ts'
import styles from './source-picker.module.css'

/**
 * The one control that turns any of three sources into a {@link PickedHar}: a
 * file dropped on the zone, a file chosen through the OS picker, or a HAR archive
 * already uploaded to the device's own FHIR server.
 *
 * @remarks
 * Drop is an enhancement, not the only path: the zone is itself a button that
 * opens the file picker, so the whole surface is reachable by keyboard and named
 * for a screen reader. A local file — dropped or chosen — is validated through
 * `web-trace-core`'s HAR parser at the picker, so a file that is not a HAR is
 * rejected *here*, next to the control the user just used, rather than surfacing
 * as a failure downstream. A server pick fetches the chosen archive and decodes
 * it through the archive codec; the resulting pick carries the archive's own
 * reference so a later step links provenance without re-uploading the bytes.
 *
 * Presentation and interaction only. Nothing here parses HAR or encodes an
 * archive — both live in `web-trace-core`, below this package.
 *
 * @packageDocumentation
 */

/** Props for {@link SourcePicker}. */
interface SourcePickerProps {
  /**
   * Called with the chosen HAR once a source resolves to one.
   *
   * @remarks
   * Fires for every accepted pick — a re-pick replaces the previous one. The
   * picker holds no selection of its own; the caller owns what happens next.
   */
  readonly onPick: (picked: PickedHar) => void
}

/** How a `null` upload instant reads in a row. */
const UNDATED_LABEL = 'Upload date unknown'

/** How an archive with no title reads in a row. */
const UNTITLED_LABEL = 'Untitled HAR archive'

/** The error shown when a chosen server archive cannot be read back. */
const SERVER_READ_ERROR = 'That archive could not be read from the server.'

/**
 * The picker: a drop-and-pick zone, the file input it opens, a rejection notice,
 * and the server archive list.
 */
const SourcePicker = ({ onPick }: SourcePickerProps): JSX.Element => {
  const runAuthed = useRunAuthed()
  const archives = useHarArchivesQuery()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const acceptFile = async (file: ReadableFile): Promise<void> => {
    const result = await acceptLocalHar(file)
    if (result.ok) {
      setError(null)
      onPick(result.picked)
    } else {
      setError(result.message)
    }
  }

  const openPicker = (): void => fileInputRef.current?.click()

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    // Reset the input so choosing the same file twice in a row still fires a
    // change — the browser suppresses it otherwise.
    event.target.value = ''
    if (file !== undefined) void acceptFile(file)
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files.item(0)
    if (file !== null) void acceptFile(file)
  }

  const onDragOver = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(true)
  }

  const selectServerArchive = async (id: string): Promise<void> => {
    try {
      const picked = await fetchHarArchive(runAuthed, id)
      setError(null)
      onPick(picked)
    } catch {
      setError(SERVER_READ_ERROR)
    }
  }

  const rows = archives.data?.pages.flatMap((page) => page.archives) ?? []

  const renderArchiveList = (): JSX.Element => {
    if (archives.isError) {
      return (
        <p role="alert" className={styles.error}>
          The uploaded archives could not be loaded.
        </p>
      )
    }
    if (rows.length === 0) {
      return <p className={styles.empty}>No HAR archives have been uploaded to this device.</p>
    }
    return (
      <ul className={styles.archiveList}>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={styles.archiveRow}
              onClick={() => {
                void selectServerArchive(row.id)
              }}
            >
              <span className={styles.archiveTitle}>{row.title ?? UNTITLED_LABEL}</span>
              <span className={styles.archiveDate}>
                {row.creation === null ? UNDATED_LABEL : DateTime.formatIsoDate(row.creation)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section aria-label="HAR source" className={styles.picker}>
      <button
        type="button"
        className={dragActive ? `${styles.zone} ${styles.zoneActive}` : styles.zone}
        onClick={openPicker}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragActive(false)}
      >
        Choose a HAR file, or drop one here
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".har,application/json"
        aria-label="HAR file"
        className={styles.fileInput}
        onChange={onFileInputChange}
      />
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.server}>
        <h3 className={styles.serverHeading}>Uploaded archives on this device</h3>
        {renderArchiveList()}
        {archives.hasNextPage && (
          <button
            type="button"
            className={styles.loadMore}
            disabled={archives.isFetchingNextPage}
            onClick={() => {
              void archives.fetchNextPage()
            }}
          >
            {archives.isFetchingNextPage ? 'Loading…' : 'Show more archives'}
          </button>
        )}
      </div>
    </section>
  )
}

export { SERVER_READ_ERROR, SourcePicker, type SourcePickerProps, UNDATED_LABEL, UNTITLED_LABEL }
