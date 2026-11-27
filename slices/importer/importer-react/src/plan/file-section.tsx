import { formatKinds } from '@wildflowerhealthio/importer-core'
import {
  type FileSetOrigin,
  FormatDecode,
  type RecordChoice,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Option } from 'effect'
import { type JSX, useId } from 'react'

import { formatRegistry } from '../registry.ts'
import type * as PlanSections from './plan-sections.ts'
import { RecordGroup } from './record-group.tsx'
import styles from './file-section.module.css'

/** What {@link FileSection} shows and does. */
interface FileSectionProps {
  /** The file set whose records it lists. */
  readonly origin: FileSetOrigin.Type
  readonly groups: readonly PlanSections.Group[]
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
}

/**
 * The display title of the format named `format` (`FileImporter`'s
 * `display.title`).
 *
 * @throws When no format of the registry is named `format`, a defect, since
 *   every file set was decoded by a registered format.
 */
const formatTitleOf = (format: string): string =>
  Arr.findFirst(formatKinds, (kind) => kind === format).pipe(
    Option.map((kind) => formatRegistry[kind].display.title),
    Option.getOrThrowWith(() => new Error(`No registered format is named ${format}`))
  )

/**
 * The records of one file set decided automatically, other than its people:
 * the format's name over the files' names, then one group per type.
 */
const FileSection = ({ origin, groups, onChoose, onReset }: FileSectionProps): JSX.Element => {
  const headingDomId = useId()
  const filesDomId = useId()
  return (
    <section aria-labelledby={`${headingDomId} ${filesDomId}`} className={styles['file-section']}>
      <div className={styles['file-section__heading']}>
        <h3 id={headingDomId} className={styles['file-section__title']}>
          {formatTitleOf(origin.format)}
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
    </section>
  )
}

export { FileSection }
export type { FileSectionProps }
