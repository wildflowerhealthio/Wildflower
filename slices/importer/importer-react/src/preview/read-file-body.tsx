import { Option } from 'effect'
import type { ServerComparison } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type FormatDecode, DecodedFile, StagedImport } from 'importer-fundamentals'
import { type JSX, useEffect, useMemo, useRef } from 'react'
import { Chip } from 'react-tundraish'

import { describeResource, resourceTypeOf } from './describe-resource.ts'
import { DiffBadge } from './diff-badge.tsx'
import { NO_RESOURCES_MESSAGE, plural, UNREADABLE_FILE_MESSAGE } from './preview-text.ts'
import styles from './preview-panel.module.css'

/**
 * One format's review body — the generalized per-resource review every format
 * shares, and the per-type tallies above it.
 *
 * @packageDocumentation
 */

/** Aggregate include/exclude totals across a file's resources, by resource type. */
interface TypeTally {
  readonly type: string
  readonly total: number
  readonly excluded: number
}

/** The per-type tallies of one format's decoded resources, in first-seen order. */
const perTypeTallies = (
  decodedFile: DecodedFile.DecodedFile,
  selection: StagedImport.Selection
): readonly TypeTally[] => {
  const order: string[] = []
  const totals = new Map<string, { total: number; excluded: number }>()
  for (const resource of DecodedFile.resources(decodedFile)) {
    const type = resourceTypeOf(resource.resource)
    const excluded = StagedImport.isResourceIncluded(selection, resource.key) ? 0 : 1
    const bucket = totals.get(type)
    if (bucket === undefined) {
      order.push(type)
      totals.set(type, { total: 1, excluded })
    } else {
      bucket.total += 1
      bucket.excluded += excluded
    }
  }
  return order.map((type) => {
    const bucket = totals.get(type) ?? { total: 0, excluded: 0 }
    return { type, total: bucket.total, excluded: bucket.excluded }
  })
}

/** The one-line tally label for one resource type ("14 MedicationRequest, 2 excluded"). */
const tallyLabel = (tally: TypeTally): string => {
  const base = `${tally.total} ${tally.type}`
  return tally.excluded === 0 ? base : `${base}, ${tally.excluded} excluded`
}

/**
 * One previewed resource's row: its type, one-line summary, include toggle,
 * Edit/Revert affordance, and the "edited" chip when a per-resource override
 * is in place.
 */
const ResourceRow = ({
  resourceKey,
  resource,
  selection,
  comparison,
  onToggle,
  onEdit,
  onRevert,
  onKeepServerValue,
}: {
  readonly resourceKey: string
  readonly resource: unknown
  readonly selection: StagedImport.Selection
  readonly comparison: ServerComparison | undefined
  readonly onToggle: (key: string) => void
  readonly onEdit: (key: string, resource: unknown) => void
  readonly onRevert: (key: string) => void
  readonly onKeepServerValue: (key: string, resource: FhirResource) => void
}): JSX.Element => {
  const edited = Option.getOrElse(
    StagedImport.editedResource(selection, resourceKey),
    () => resource
  )
  const description = describeResource(edited)
  const included = StagedImport.isResourceIncluded(selection, resourceKey)
  const isEdited = StagedImport.isResourceEdited(selection, resourceKey)
  return (
    <li className={styles.resourceRow}>
      <label className={styles.resourceLabel}>
        <input
          type="checkbox"
          checked={included}
          aria-label={`Include ${description.type} ${description.summary}`}
          onChange={() => onToggle(resourceKey)}
        />
        <span className={included ? styles.resourceType : styles.resourceExcluded}>
          {description.type}
        </span>
        <span className={included ? styles.resourceSummary : styles.resourceExcluded}>
          {description.summary}
        </span>
      </label>
      <DiffBadge
        comparison={comparison}
        current={edited}
        onKeepServerValue={(next) => onKeepServerValue(resourceKey, next)}
      />
      {isEdited && <Chip className={styles.editedChip}>Edited</Chip>}
      <button
        type="button"
        className={styles.editButton}
        onClick={() => onEdit(resourceKey, edited)}
        aria-label={`Edit ${description.type} ${description.summary}`}
      >
        Edit
      </button>
      {isEdited && (
        <button
          type="button"
          className={styles.revertButton}
          onClick={() => onRevert(resourceKey)}
          aria-label={`Revert edit to ${description.type} ${description.summary}`}
        >
          Revert
        </button>
      )}
    </li>
  )
}

/**
 * A section's heading with a tri-state include toggle: checked when every
 * resource in the section is included, unchecked when none are, indeterminate
 * in between. Clicking it opts the whole section in or out in one go — out when
 * everything was included, in otherwise — through {@link StagedImport.setResourcesIncluded}.
 *
 * @remarks
 * `indeterminate` is not a React-settable attribute, so it is written onto the
 * input element through a ref after render whenever the mixed state changes.
 */
const SectionToggle = ({
  title,
  resourceKeys,
  selection,
  onSelectionChange,
}: {
  readonly title: string
  readonly resourceKeys: readonly string[]
  readonly selection: StagedImport.Selection
  readonly onSelectionChange: (selection: StagedImport.Selection) => void
}): JSX.Element => {
  const includedCount = resourceKeys.filter((key) =>
    StagedImport.isResourceIncluded(selection, key)
  ).length
  const allIncluded = resourceKeys.length > 0 && includedCount === resourceKeys.length
  const noneIncluded = includedCount === 0
  const checkbox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (checkbox.current !== null) checkbox.current.indeterminate = !allIncluded && !noneIncluded
  }, [allIncluded, noneIncluded])
  return (
    <label className={styles.sectionHeadingLabel}>
      <input
        ref={checkbox}
        type="checkbox"
        checked={allIncluded}
        aria-label={`Include all in ${title}`}
        onChange={() => {
          onSelectionChange(
            StagedImport.setResourcesIncluded(selection, resourceKeys, !allIncluded)
          )
        }}
      />
      <h4 className={styles.sectionHeading}>{title}</h4>
    </label>
  )
}

/**
 * One format's decoded sections and notes — the generalized review body
 * every format shares: a per-type tally, one titled section per decode
 * section with per-resource rows, and the format's diagnostic notes folded
 * into a collapsed details block.
 */
const ReadFileBody = ({
  result,
  selection,
  comparisons,
  onSelectionChange,
  onEditResource,
}: {
  readonly result: FormatDecode.Result<string>
  readonly selection: StagedImport.Selection
  readonly comparisons: ReadonlyMap<string, ServerComparison> | undefined
  readonly onSelectionChange: (selection: StagedImport.Selection) => void
  readonly onEditResource: (key: string, resource: unknown) => void
}): JSX.Element => {
  const { sections, notes } = result.decoded
  const tallies = useMemo(
    () => perTypeTallies(result.decoded, selection),
    [result.decoded, selection]
  )
  return (
    <div className={styles.readBody}>
      {tallies.length > 0 && (
        <p role="status" className={styles.tally}>
          {tallies.map(tallyLabel).join(' · ')}
        </p>
      )}
      {sections.length === 0 && result.unreadableFiles.length === 0 && (
        <p className={styles.emptyMessage}>{NO_RESOURCES_MESSAGE}</p>
      )}
      {result.unreadableFiles.length > 0 && (
        <ul className={styles.noteList}>
          {result.unreadableFiles.map((file) => (
            <li key={file.id} className={styles.note}>
              {file.title}: {UNREADABLE_FILE_MESSAGE}
            </li>
          ))}
        </ul>
      )}
      {sections.map((section) => (
        <section
          // A resource key is namespaced by the file it came from
          // (`FormatDecode.keyPrefix`), so it is unique across the format —
          // which lets a section's first resource identify it even when two
          // files contribute sections of the same title.
          key={section.resources[0]?.key ?? section.title}
          className={styles.decodeSection}
          aria-label={section.title}
        >
          <SectionToggle
            title={section.title}
            resourceKeys={section.resources.map((resource) => resource.key)}
            selection={selection}
            onSelectionChange={onSelectionChange}
          />
          <ul className={styles.resourceList}>
            {section.resources.map((resource) => (
              <ResourceRow
                key={resource.key}
                resourceKey={resource.key}
                resource={resource.resource}
                selection={selection}
                comparison={comparisons?.get(resource.key)}
                onToggle={(key) => onSelectionChange(StagedImport.toggleResource(selection, key))}
                onEdit={onEditResource}
                onRevert={(key) => onSelectionChange(StagedImport.revert(selection, key))}
                onKeepServerValue={(key, next) =>
                  onSelectionChange(StagedImport.edit(selection, key, next))
                }
              />
            ))}
          </ul>
        </section>
      ))}
      {notes.length > 0 && (
        <details className={styles.notes}>
          <summary className={styles.notesSummary}>
            {`${notes.length} ${plural(notes.length, 'note')}`}
          </summary>
          <ul className={styles.noteList}>
            {notes.map((note) => (
              <li key={note} className={styles.note}>
                {note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export { ReadFileBody }
