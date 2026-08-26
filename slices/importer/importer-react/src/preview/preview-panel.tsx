import type { JSX } from 'react'

import type { FhirResource } from 'fhir-r4/resources'
import type { ImportPreview } from 'importer-core'

import { previewResourceCount } from '../results/import-outcome.ts'
import type { ReadEntry } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: exactly what the import would write, shown before anything
 * touches the server, so confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently, and this
 * panel renders them together under one confirm. Every file's outcome renders
 * honestly and distinctly — there is no empty section:
 *
 * - **No importer claimed** (`NoSourceClaims`) — a plain "nothing here is
 *   recognized" state naming how many entries were read, so a browser's HAR of a
 *   site we have no source for reads as a fact, not a failure.
 * - **An importer claimed but matched nothing** (a `Preview` with no resources) —
 *   distinct from the above: the importer *did* recognize the traffic, it just
 *   produced no resources, and the entry counts explain why.
 * - **An importer claimed and produced resources** — per-`resourceType` sections
 *   with counts and a summary row per resource, the inferred source root(s) and
 *   detected importer shown for transparency (not editable — the recognition is
 *   zero-config), and honest notices for unmatched entries, absent bodies, and
 *   responses that matched a pattern but failed to decode.
 * - **Unreadable** — a file that did not parse as a HAR at all, reported against
 *   its own name rather than sinking the batch.
 *
 * The single confirm action appears only when at least one file has something to
 * write, and it opts into writing *every* writable file; the other states offer
 * only a way back. Confirming here does not write — it calls `onConfirm`, and the
 * confirm step (upload-then-persist, per file) is what writes.
 *
 * @packageDocumentation
 */

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly entries: readonly ReadEntry[]
  /**
   * Called when the user confirms the batch. Fires only when at least one file
   * has a claimed preview with resources to write; the panel gates the
   * affordance, so a caller can treat this as "the user opted in to writing the
   * batch".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to disable the action. */
  readonly confirming: boolean
}

/** Heading for a batch with nothing to write — no file was recognized, or all were empty. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing to import'

/** Heading for a batch that has resources to write. */
const PREVIEW_HEADING = 'Ready to import'

/** Message for a file that did not parse as a HAR at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read as a HAR.'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** "read 5 entries" / "read 1 entry" — the entry-count phrasing shared by states. */
const entriesRead = (count: number): string => `Read ${count} ${count === 1 ? 'entry' : 'entries'}`

/** The transparency block: the detected importer and the source root(s) it keyed under. */
const RecognitionSummary = ({
  preview,
}: {
  readonly preview: ImportPreview.Preview
}): JSX.Element => (
  <dl className={styles.recognition}>
    <div className={styles.recognitionRow}>
      <dt className={styles.recognitionTerm}>Source</dt>
      <dd className={styles.recognitionValue}>{preview.sourceTag}</dd>
    </div>
    <div className={styles.recognitionRow}>
      <dt className={styles.recognitionTerm}>{plural(preview.rootUrls.length, 'Source root')}</dt>
      <dd className={styles.recognitionValue}>
        {preview.rootUrls.length === 0 ? (
          <span className={styles.muted}>none</span>
        ) : (
          <ul className={styles.rootList}>
            {preview.rootUrls.map((root) => (
              <li key={root} className={styles.rootUrl}>
                {root}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  </dl>
)

/** One `resourceType` section: its count and a summary row per resource. */
const ResourceTypeSection = ({
  resourceType,
  resources,
}: {
  readonly resourceType: string
  readonly resources: readonly FhirResource[]
}): JSX.Element => (
  <section className={styles.typeSection} aria-label={`${resourceType} resources`}>
    <h4 className={styles.typeHeading}>
      {resourceType} <span className={styles.typeCount}>({resources.length})</span>
    </h4>
    <ul className={styles.resourceList}>
      {resources.map((resource) => (
        // Resources are re-keyed under their source root before a preview, so an
        // id is present and unique within a type; the fallback only guards the
        // theoretical null-id row from becoming an unkeyed one.
        <li key={resource.id ?? `${resourceType}-no-id`} className={styles.resourceRow}>
          {resource.id ?? <span className={styles.muted}>(no id)</span>}
        </li>
      ))}
    </ul>
  </section>
)

/** The honest notices around the written resources: absent bodies, unmatched noise, decode failures. */
const PreviewNotices = ({ preview }: { readonly preview: ImportPreview.Preview }): JSX.Element => (
  <div className={styles.notices}>
    {preview.unmatchedCount > 0 && (
      <p className={styles.notice}>
        {`${preview.unmatchedCount} other ${preview.unmatchedCount === 1 ? 'entry' : 'entries'} went unrecognized.`}
      </p>
    )}
    {preview.bodyAbsentCount > 0 && (
      <p className={styles.notice}>
        {`${preview.bodyAbsentCount} matched ${plural(preview.bodyAbsentCount, 'response')} stored no body and ${preview.bodyAbsentCount === 1 ? 'was' : 'were'} skipped.`}
      </p>
    )}
    {preview.parseFailures.length > 0 && (
      <div role="alert" className={styles.parseFailures}>
        <p className={styles.noticeStrong}>
          {`${preview.parseFailures.length} matched ${plural(preview.parseFailures.length, 'response')} could not be decoded:`}
        </p>
        <ul className={styles.parseFailureList}>
          {preview.parseFailures.map((failure) => (
            <li key={failure.url} className={styles.parseFailureUrl}>
              {failure.url}
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
)

/** One claimed preview's content: recognition, the resources it would write, and its notices. */
const ClaimedBody = ({ preview }: { readonly preview: ImportPreview.Preview }): JSX.Element => {
  const resourceTypes = Object.entries(preview.resourcesByType)
  if (previewResourceCount(preview) === 0) {
    return (
      <>
        <p role="status" className={styles.emptyMessage}>
          {`The ${preview.sourceTag} importer recognized this archive, but matched no resources to import.`}
        </p>
        <RecognitionSummary preview={preview} />
        <PreviewNotices preview={preview} />
      </>
    )
  }
  return (
    <>
      <RecognitionSummary preview={preview} />
      <div className={styles.typeSections}>
        {resourceTypes.map(([resourceType, resources]) => (
          <ResourceTypeSection
            key={resourceType}
            resourceType={resourceType}
            resources={resources}
          />
        ))}
      </div>
      <PreviewNotices preview={preview} />
    </>
  )
}

/** One file's body: unreadable, no-source, or the claimed preview's content. */
const FileBody = ({ entry }: { readonly entry: ReadEntry }): JSX.Element => {
  if (entry._tag === 'unreadable') {
    return (
      <p role="alert" className={styles.emptyMessage}>
        {UNREADABLE_FILE_MESSAGE}
      </p>
    )
  }
  if (entry.preview._tag === 'NoSourceClaims') {
    return (
      <p role="status" className={styles.emptyMessage}>
        {`${entriesRead(entry.preview.totalEntries)}, but no known source recognized any of them.`}
      </p>
    )
  }
  return <ClaimedBody preview={entry.preview} />
}

/** One file's whole outcome, under its own name — the unit the batch is built from. */
const FileSection = ({ entry }: { readonly entry: ReadEntry }): JSX.Element => (
  <section className={styles.fileSection} aria-label={entry.picked.fileName}>
    <h3 className={styles.fileHeading}>{entry.picked.fileName}</h3>
    <FileBody entry={entry} />
  </section>
)

/** The single action row for the whole batch: confirm (when anything is writable) and cancel. */
const PreviewActions = ({
  writableCount,
  onConfirm,
  onCancel,
  confirming,
}: {
  readonly writableCount: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly confirming: boolean
}): JSX.Element => (
  <div className={styles.actions}>
    <button type="button" className={styles.cancel} onClick={onCancel} disabled={confirming}>
      Cancel
    </button>
    {writableCount > 0 && (
      <button type="button" className={styles.confirm} onClick={onConfirm} disabled={confirming}>
        {confirming ? 'Importing…' : `Import ${writableCount} ${plural(writableCount, 'resource')}`}
      </button>
    )}
  </div>
)

/** The resources a batch of read entries would write, summed across its files. */
const writableCountOf = (entries: readonly ReadEntry[]): number =>
  entries.reduce(
    (total, entry) =>
      entry._tag === 'read' && entry.preview._tag === 'Preview'
        ? total + previewResourceCount(entry.preview)
        : total,
    0
  )

/**
 * The preview surface. Renders every picked file's read outcome and, when at
 * least one has something to write, the single confirm action that opts into
 * writing the whole batch.
 */
const PreviewPanel = ({
  entries,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  const writableCount = writableCountOf(entries)
  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {entries.length > 1 && writableCount > 0 && (
        <p role="status" className={styles.batchSummary}>
          {`${writableCount} ${plural(writableCount, 'resource')} across ${entries.length} files`}
        </p>
      )}
      <div className={styles.fileSections}>
        {entries.map((entry) => (
          <FileSection key={entry.id} entry={entry} />
        ))}
      </div>
      <PreviewActions
        writableCount={writableCount}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirming={confirming}
      />
    </section>
  )
}

export {
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  UNREADABLE_FILE_MESSAGE,
}
