import { DateTime } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import { useState, type JSX } from 'react'

import { fetchHarArchive, useHarArchivesQuery } from '../queries/har-archives.ts'
import type { PickedHar } from './picked-har.ts'
import styles from './server-har-archive-list.module.css'

/**
 * The HAR archives already uploaded to the device's own FHIR server, as a pick
 * source: a titled row per archive, paged by the bundle's next link, fetching
 * the selected archive back through the codec.
 *
 * @remarks
 * Extracted from {@link SourcePicker} so a host outside this slice — the
 * anonymizer shell's `serverSource` slot — can offer the same server picks
 * without importing the whole picker. Reads only: the list is a search, a
 * selection is a `DocumentReference` GET, and nothing here writes.
 *
 * @packageDocumentation
 */

/** How a `null` upload instant reads in a row. */
const UNDATED_LABEL = 'Upload date unknown'

/** How an archive with no title reads in a row. */
const UNTITLED_LABEL = 'Untitled HAR archive'

/** The error shown when a chosen server archive cannot be read back. */
const SERVER_READ_ERROR = 'That archive could not be read from the server.'

/** Props for {@link ServerHarArchiveList}. */
interface ServerHarArchiveListProps {
  /** Called with the fetched archive once a selected row resolves. */
  readonly onPick: (picked: PickedHar) => void
}

/** The uploaded-archives list, heading and paging included. */
const ServerHarArchiveList = ({ onPick }: ServerHarArchiveListProps): JSX.Element => {
  const runAuthed = useRunAuthed()
  const archives = useHarArchivesQuery()
  const [error, setError] = useState<string | null>(null)

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
    // `rows.length === 0` is also true on the very first fetch, so the pending
    // state is checked first — otherwise the list would flash "none uploaded"
    // before the server has answered.
    if (archives.isPending) {
      return (
        <p role="status" className={styles.empty}>
          Loading uploaded archives…
        </p>
      )
    }
    if (rows.length === 0) {
      return <p className={styles.empty}>No HAR archives have been uploaded to the FHIR server.</p>
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
    <div className={styles.server}>
      <h3 className={styles.serverHeading}>Uploaded archives on the FHIR server</h3>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
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
  )
}

export {
  SERVER_READ_ERROR,
  ServerHarArchiveList,
  type ServerHarArchiveListProps,
  UNDATED_LABEL,
  UNTITLED_LABEL,
}
