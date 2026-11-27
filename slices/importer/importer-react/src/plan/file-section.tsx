import type { FormatKind, FormatSettings } from '@wildflowerhealthio/importer-core'
import {
  type FileSetOrigin,
  FormatDecode,
  type RecordChoice,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { type JSX, useId } from 'react'

import { formatRegistry } from '../registry.ts'
import { FileSettings } from './file-settings.tsx'
import type * as PlanSections from './plan-sections.ts'
import { RecordGroup } from './record-group.tsx'
import styles from './file-section.module.css'

/** What {@link FileSection} shows and does. */
interface FileSectionProps {
  /** The file set it is of. */
  readonly origin: FileSetOrigin.Type
  /** The registered format that read it. */
  readonly format: FormatKind
  readonly groups: readonly PlanSections.Group[]
  /** What the set's decode noted. */
  readonly notes: readonly string[]
  /** How many file sets of its format the import holds. */
  readonly formatFileSets: number
  /** Every format's settings as the reviewer last set them. */
  readonly settings: FormatSettings
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
  readonly onApplySettings: <K extends FormatKind>(
    format: K,
    formatSettings: FormatSettings[K]
  ) => void
}

/**
 * One file set: the format's name over the files' names, one group per type
 * of the records it brought that were decided automatically, other than its
 * people, then what its decode noted, one line each, and its format's
 * Settings.
 */
const FileSection = ({
  origin,
  format,
  groups,
  notes,
  formatFileSets,
  settings,
  onChoose,
  onReset,
  onApplySettings,
}: FileSectionProps): JSX.Element => {
  const headingDomId = useId()
  const filesDomId = useId()
  return (
    <section aria-labelledby={`${headingDomId} ${filesDomId}`} className={styles['file-section']}>
      <div className={styles['file-section__heading']}>
        <h3 id={headingDomId} className={styles['file-section__title']}>
          {formatRegistry[format].display.title}
        </h3>
        <span id={filesDomId} className={styles['file-section__files']}>
          {FormatDecode.titleOf(origin.pickedFiles)}
        </span>
      </div>
      {groups.map((group) => (
        <RecordGroup
          key={group.resourceType}
          group={group}
          sectionTag="FileSet"
          onChoose={onChoose}
          onReset={onReset}
        />
      ))}
      {notes.length === 0 ? null : (
        <ul className={styles['file-section__notes']}>
          {notes.map((note, index) => (
            // A decode may note one thing twice, and a note never moves, so its place keys it.
            // oxlint-disable-next-line react/no-array-index-key -- see above
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      <FileSettings
        format={format}
        settings={settings}
        formatFileSets={formatFileSets}
        onApplySettings={onApplySettings}
      />
    </section>
  )
}

export { FileSection }
export type { FileSectionProps }
