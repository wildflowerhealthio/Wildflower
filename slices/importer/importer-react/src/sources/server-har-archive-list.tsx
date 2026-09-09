import { DateTime, Match } from 'effect'
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

/** Props for {@link ArchiveListContent}. */
interface ArchiveListContentProps {
  readonly isError: boolean
  readonly isPending: boolean
  readonly rows: readonly {
    readonly id: string
    readonly title: string | null
    readonly creation: DateTime.DateTime | null
  }[]
  readonly onSelect: (id: string) => void
}

/** The inner list content, rendered via Match over the query state. */
const ArchiveListContent = ({
  isError,
  isPending,
  rows,
  onSelect,
}: ArchiveListContentProps): JSX.Element =>
  Match.value({ isError, isPending, empty: rows.length === 0 }).pipe(
    Match.when({ isError: true }, () => (
      <p role="alert" className={styles.error}>
        The uploaded archives could not be loaded.
      </p>
    )),
    Match.when({ isPending: true }, () => (
      <p role="status" className={styles.empty}>
        Loading uploaded archives…
      </p>
    )),
    Match.when({ empty: true }, () => (
      <p className={styles.empty}>No HAR archives have been uploaded to the FHIR server.</p>
    )),
    Match.orElse(() => (
      <ul className={styles.archiveList}>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={styles.archiveRow}
              onClick={() => {
                onSelect(row.id)
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
    ))
  )

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

  return (
    <div className={styles.server}>
      <h3 className={styles.serverHeading}>Uploaded archives on the FHIR server</h3>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <ArchiveListContent
        isError={archives.isError}
        isPending={archives.isPending}
        rows={rows}
        onSelect={selectServerArchive}
      />
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
