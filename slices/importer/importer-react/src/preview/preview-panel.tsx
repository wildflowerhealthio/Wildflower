import type { JSX } from 'react'

import type { FhirResource } from 'fhir-r4/resources'
import type { ImportPreview, Preview } from 'importer-core'

import { previewResourceCount } from '../results/import-outcome.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: exactly what the import would write, shown before anything
 * touches the server, so confirming is an informed, opt-in act.
 *
 * @remarks
 * Every outcome of the read half renders honestly and distinctly — there is no
 * empty screen:
 *
 * - **No collector claimed** (`NoCollectorClaims`) — a plain "nothing here is
 *   recognized" state naming how many entries were read, so a browser's HAR of a
 *   site we have no collector for reads as a fact, not a failure.
 * - **A collector claimed but matched nothing** (a `Preview` with no resources) —
 *   distinct from the above: the collector *did* recognize the traffic, it just
 *   produced no resources, and the entry counts explain why.
 * - **A collector claimed and produced resources** — per-`resourceType` sections
 *   with counts and a summary row per resource, the inferred source root(s) and
 *   detected collector shown for transparency (not editable — the recognition is
 *   zero-config), and honest notices for unmatched entries, absent bodies, and
 *   responses that matched a pattern but failed to decode.
 *
 * The confirm action appears only when there is something to write; the other
 * states offer only a way back. Confirming here does not write — it calls
 * `onConfirm`, and the confirm step (upload-then-persist) is what writes.
 *
 * @packageDocumentation
 */

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** The preview to render — either outcome of the read half. */
  readonly preview: ImportPreview
  /**
   * Called when the user confirms an import. Fires only for a claimed preview
   * that has at least one resource to write; the panel gates the affordance, so a
   * caller can treat this as "the user opted in to writing these resources".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to disable the action. */
  readonly confirming: boolean
}

/** Heading for the no-collector state — a whole-archive "not recognized". */
const NO_COLLECTOR_HEADING = 'No collector recognized this archive'

/** Heading for a claimed-but-empty preview — recognized, but nothing to import. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing in this archive to import'

/** Heading for a claimed preview that has resources to write. */
const PREVIEW_HEADING = 'Ready to import'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** "read 5 entries" / "read 1 entry" — the entry-count phrasing shared by states. */
const entriesRead = (count: number): string => `Read ${count} ${count === 1 ? 'entry' : 'entries'}`

/** The transparency block: the detected collector and the source root(s) it keyed under. */
const RecognitionSummary = ({ preview }: { readonly preview: Preview }): JSX.Element => (
  <dl className={styles.recognition}>
    <div className={styles.recognitionRow}>
      <dt className={styles.recognitionTerm}>Collector</dt>
      <dd className={styles.recognitionValue}>{preview.collectorTag}</dd>
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
    <h3 className={styles.typeHeading}>
      {resourceType} <span className={styles.typeCount}>({resources.length})</span>
    </h3>
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
const PreviewNotices = ({ preview }: { readonly preview: Preview }): JSX.Element => (
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

/** The action row shared by every state: confirm (when writable) and cancel. */
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

/**
 * The preview surface. Renders the read half's outcome and, when there is
 * something to write, the single confirm action that opts into writing it.
 */
const PreviewPanel = ({
  preview,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  if (preview._tag === 'NoCollectorClaims') {
    return (
      <section aria-label="Import preview" className={styles.panel}>
        <h2 className={styles.heading}>{NO_COLLECTOR_HEADING}</h2>
        <p role="status" className={styles.emptyMessage}>
          {entriesRead(preview.totalEntries)}, but no registered collector recognized any of them.
        </p>
        <PreviewActions
          writableCount={0}
          onConfirm={onConfirm}
          onCancel={onCancel}
          confirming={confirming}
        />
      </section>
    )
  }

  const writableCount = previewResourceCount(preview)
  const resourceTypes = Object.entries(preview.resourcesByType)

  if (writableCount === 0) {
    return (
      <section aria-label="Import preview" className={styles.panel}>
        <h2 className={styles.heading}>{NOTHING_TO_IMPORT_HEADING}</h2>
        <p role="status" className={styles.emptyMessage}>
          The {preview.collectorTag} collector recognized this archive, but matched no resources to
          import.
        </p>
        <RecognitionSummary preview={preview} />
        <PreviewNotices preview={preview} />
        <PreviewActions
          writableCount={0}
          onConfirm={onConfirm}
          onCancel={onCancel}
          confirming={confirming}
        />
      </section>
    )
  }

  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>{PREVIEW_HEADING}</h2>
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
  NO_COLLECTOR_HEADING,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
}
