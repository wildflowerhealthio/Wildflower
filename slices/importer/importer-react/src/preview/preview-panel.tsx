import { Data, Match, Option } from 'effect'
import {
  diffJson,
  type DiffStatus,
  type FieldDiff,
  formatPath,
  formatSlot,
  normalizedEncode,
  resetFieldToServer,
  type ServerComparison,
} from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledSection } from 'importer-fundamentals'
import { StagedImport, sectionResources } from 'importer-fundamentals'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from 'react-tundraish'

import type { BoundFormat, FormatKind, FormatSettings } from '../registry.ts'
import { formatKinds } from '../registry.ts'
import { describeResource, resourceTypeOf } from './describe-resource.ts'
import { ResourceEditor } from './resource-editor.tsx'
import type { FileReadOutcome, ReadFile, UnreadableFile } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-resource review of exactly what
 * the import would write, shown before anything touches the server, so
 * confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently and
 * rendered together under one confirm. The display is fully general — the
 * same for every format: files grouped by format under that format's
 * settings form, each read file showing its decoded sections (title +
 * per-resource rows with include/edit/revert) and its diagnostic notes,
 * an unreadable file reported against its own name rather than sinking
 * the batch. A settings change calls `onSettingsChange`; the shell
 * re-decodes that format's files. The confirm appears only when at least
 * one resource is included, and it does not write — it calls `onConfirm`;
 * the confirm step writes exactly the reviewed objects.
 *
 * @packageDocumentation
 */

/**
 * The registry-shaped structure this panel reads per format: the display
 * strings for the group heading and the `SettingsPicker` for its form.
 */
type SettingsRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'display' | 'SettingsPicker'>
}

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly files: readonly FileReadOutcome[]
  /** The current per-format settings the decodes ran under. */
  readonly settings: FormatSettings
  /** The registered formats' display + settings pickers, indexed by kind. */
  readonly settingsRegistry: SettingsRegistry
  /** The reviewed selection for a file (defaults to `StagedImport.initial()` before any edit). */
  readonly selectionFor: (fileId: string) => StagedImport.Selection<FhirResource>
  /**
   * Each labeled resource's server comparison (`new` / `unchanged` /
   * `changed`, and for `changed` the leaf-level field diffs), keyed by
   * {@link LabeledResource.key}. Rendered as a badge on each row — the
   * `changed` badge opens to show `field "server" -> "import"` with a
   * per-field reset. A key absent from the map (the pre-fetch is still in
   * flight, or the resource is not covered by the classifier) renders no
   * badge.
   */
  readonly comparisons: ReadonlyMap<string, ServerComparison>
  /** Called when a file's review changes its selection. */
  readonly onSelectionChange: (
    fileId: string,
    selection: StagedImport.Selection<FhirResource>
  ) => void
  /** Called when the user changes one format's settings; the caller re-decodes. */
  readonly onSettingsChange: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  /**
   * Called when the user confirms the batch. Fires only when at least one
   * resource is included; the panel gates the affordance, so a caller can
   * treat this as "the user opted in to writing the batch".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to disable the action. */
  readonly confirming: boolean
}

/** Heading for a batch with nothing chosen — no resource is included. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing to import'

/** Heading for a batch that has resources to write. */
const PREVIEW_HEADING = 'Ready to import'

/** Message for a file that did not parse at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read.'

/** Message for a file no registered format recognized. */
const UNRECOGNIZED_FILE_MESSAGE = 'This file was not a format the importer recognizes.'

/** Message for a read file whose decode yielded no importable resources. */
const NO_RESOURCES_MESSAGE = 'No importable resources in this file.'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** The confirm button's label, factored out so the render stays a single expression. */
const confirmLabel = (writable: number, excluded: number, confirming: boolean): string => {
  if (confirming) return 'Importing…'
  const base = `Import ${writable} ${plural(writable, 'resource')}`
  return excluded > 0 ? `${base} (${excluded} excluded)` : base
}

/** Aggregate include/exclude totals across a file's resources, by resource type. */
interface TypeTally {
  readonly type: string
  readonly total: number
  readonly excluded: number
}

/** The per-type tallies of one file's decoded resources, in first-seen order. */
const perTypeTallies = (
  sections: readonly LabeledSection<FhirResource>[],
  selection: StagedImport.Selection<FhirResource>
): readonly TypeTally[] => {
  const order: string[] = []
  const totals = new Map<string, { total: number; excluded: number }>()
  for (const resource of sectionResources(sections)) {
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
 * One format's settings form, dispatched on the format tag so the picker
 * component and the settings value line up per branch — no cast.
 *
 * @remarks
 * `Match.exhaustive` rather than an `if`/fallthrough: every branch is
 * identical but for `kind`, and a fallthrough silently binds one format's
 * group to another format's picker — which is what happened when `dicom`
 * joined the registry and kept editing the LifeLabs settings, leaving DICOM
 * decoding under its defaults forever. Registering a format without a branch
 * here must fail to compile, and with `Match.exhaustive` it does.
 */
const FormatSettingsForm = ({
  format,
  settings,
  settingsRegistry,
  onSettingsChange,
}: {
  readonly format: FormatKind
  readonly settings: FormatSettings
  readonly settingsRegistry: SettingsRegistry
  readonly onSettingsChange: PreviewPanelProps['onSettingsChange']
}): JSX.Element => {
  // Each branch re-indexes on its own literal `kind`, the way `runDecode`
  // does: a shared generic helper loses the correlation between
  // `FormatVariant[K]['settings']` and `FormatSettings[K]` and stops
  // type-checking.
  return Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => {
      const Picker = settingsRegistry[kind].SettingsPicker
      return <Picker settings={settings[kind]} onChange={(next) => onSettingsChange(kind, next)} />
    }),
    Match.when('lifelabs-pdf', (kind) => {
      const Picker = settingsRegistry[kind].SettingsPicker
      return <Picker settings={settings[kind]} onChange={(next) => onSettingsChange(kind, next)} />
    }),
    Match.when('dicom', (kind) => {
      const Picker = settingsRegistry[kind].SettingsPicker
      return <Picker settings={settings[kind]} onChange={(next) => onSettingsChange(kind, next)} />
    }),
    Match.exhaustive
  )(format)
}

/**
 * One previewed resource's row: its type, one-line summary, include toggle,
 * Edit/Revert affordance, and the "edited" chip when a per-resource override
 * is in place.
 */
/** User-visible label for each diff status. */
const DIFF_STATUS_LABEL: Record<DiffStatus, string> = {
  new: 'New',
  unchanged: 'Already on server',
  changed: 'Differs from server',
}

/**
 * The leaf diffs standing between the current (possibly edited) resource and
 * the server, recomputed against `current` — not the classify snapshot — so
 * the badge reflects exactly what a save would write: an edit to an otherwise
 * unchanged resource surfaces here, and a reset leaf drops out the instant it
 * matches again. Falls back to the snapshot `fields` when the current resource
 * cannot be re-encoded. `undefined` when the server holds no copy to diff
 * against (`new`, or an opaque `changed`).
 */
const liveFields = (
  comparison: ServerComparison,
  current: unknown
): readonly FieldDiff[] | undefined => {
  const server = comparison.server
  if (server === undefined) return undefined
  return Option.match(normalizedEncode(current), {
    onNone: () => comparison.fields,
    onSome: (value) => diffJson(server, value),
  })
}

/**
 * The interactive detail for a `changed` badge: one `path "server" ->
 * "import"` line per differing leaf, each with a "keep server value" button
 * that resets that one leaf on the incoming resource back to the server's.
 */
const DiffFieldList = ({
  fields,
  current,
  onKeepServerValue,
}: {
  readonly fields: readonly FieldDiff[]
  readonly current: unknown
  readonly onKeepServerValue: (resource: FhirResource) => void
}): JSX.Element => (
  <ul className={styles.diffFieldList} role="group" aria-label="Field differences">
    {fields.map((field) => {
      const path = formatPath(field.path)
      return (
        <li key={path} className={styles.diffField}>
          <code className={styles.diffPath}>{path}</code>
          <span className={styles.diffServer}>{formatSlot(field.server)}</span>
          <span className={styles.diffArrow} aria-hidden="true">
            →
          </span>
          <span className={styles.diffIncoming}>{formatSlot(field.incoming)}</span>
          <button
            type="button"
            className={styles.keepServerButton}
            aria-label={`Keep the server value for ${path}`}
            onClick={() =>
              Option.match(resetFieldToServer(current, field), {
                onNone: () => undefined,
                onSome: onKeepServerValue,
              })
            }
          >
            Keep server value
          </button>
        </li>
      )
    })}
  </ul>
)

/**
 * Badge shown on a resource row from the server-diff pre-fetch, reflecting the
 * *current* (possibly edited) resource against the server:
 *
 * - `new` (no server copy) — a static "New" chip.
 * - a server copy the current resource matches — a static "Already on server"
 *   chip (whether it always matched, or an edit/reset just brought it back).
 * - a server copy the current resource differs from — an interactive
 *   disclosure: hover *or* click the badge to reveal each `field "server" ->
 *   "import"` line and its per-field reset. This is what surfaces an edit to
 *   an otherwise-unchanged resource, and updates live as the reviewer edits.
 *
 * Absent when the status is unknown (the pre-fetch is still in flight, or the
 * row's key is not in the map).
 */
const DiffBadge = ({
  comparison,
  current,
  onKeepServerValue,
}: {
  readonly comparison: ServerComparison | undefined
  readonly current: unknown
  readonly onKeepServerValue: (resource: FhirResource) => void
}): JSX.Element | null => {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  if (comparison === undefined) return null
  const fields = liveFields(comparison, current)
  // No server copy to diff against: report the classify-time status verbatim
  // (`new`, or an opaque `changed` whose server copy would not decode).
  if (fields === undefined) {
    const { status } = comparison
    return (
      <Chip
        className={styles[`diffBadge_${status}`] ?? styles.diffBadge}
        data-diff-status={status}
        aria-label={DIFF_STATUS_LABEL[status]}
      >
        {DIFF_STATUS_LABEL[status]}
      </Chip>
    )
  }
  // A server copy exists and the current resource matches it.
  if (fields.length === 0) {
    return (
      <Chip
        className={styles.diffBadge_unchanged ?? styles.diffBadge}
        data-diff-status="unchanged"
        aria-label={DIFF_STATUS_LABEL.unchanged}
      >
        {DIFF_STATUS_LABEL.unchanged}
      </Chip>
    )
  }
  const open = pinned || hovered
  const label = `${DIFF_STATUS_LABEL.changed}: ${fields.length} ${plural(fields.length, 'field')}`
  return (
    <span
      className={styles.diffContainer}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.diffBadge_changed ?? styles.diffBadge}
        data-diff-status="changed"
        aria-expanded={open}
        aria-label={`${label}; show differences`}
        onClick={() => setPinned((previous) => !previous)}
      >
        {label}
      </button>
      {open && (
        <div className={styles.diffDetails}>
          <DiffFieldList fields={fields} current={current} onKeepServerValue={onKeepServerValue} />
        </div>
      )}
    </span>
  )
}

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
  readonly selection: StagedImport.Selection<FhirResource>
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
  readonly selection: StagedImport.Selection<FhirResource>
  readonly onSelectionChange: (selection: StagedImport.Selection<FhirResource>) => void
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
 * One read file's decoded sections and notes — the generalized review body
 * every format shares: a per-type tally, one titled section per decode
 * section with per-resource rows, and the file's diagnostic notes folded
 * into a collapsed details block.
 */
const ReadFileBody = ({
  file,
  selection,
  comparisons,
  onSelectionChange,
  onEditResource,
}: {
  readonly file: ReadFile<FormatKind>
  readonly selection: StagedImport.Selection<FhirResource>
  readonly comparisons: ReadonlyMap<string, ServerComparison>
  readonly onSelectionChange: (selection: StagedImport.Selection<FhirResource>) => void
  readonly onEditResource: (key: string, resource: unknown) => void
}): JSX.Element => {
  const { sections, notes } = file.decoded
  const tallies = useMemo(() => perTypeTallies(sections, selection), [sections, selection])
  return (
    <div className={styles.readBody}>
      {tallies.length > 0 && (
        <p role="status" className={styles.tally}>
          {tallies.map(tallyLabel).join(' · ')}
        </p>
      )}
      {sections.length === 0 && <p className={styles.emptyMessage}>{NO_RESOURCES_MESSAGE}</p>}
      {sections.map((section) => (
        <section
          // Resource keys are unique per file, so a section's first resource
          // identifies it even when two sections share a title.
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
                comparison={comparisons.get(resource.key)}
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

/** One file's whole outcome, under its own name — the unit a format group is built from. */
const FileSection = ({
  file,
  selectionFor,
  comparisons,
  onSelectionChange,
  onEditResource,
}: {
  readonly file: ReadFile<FormatKind> | UnreadableFile<FormatKind> | FileReadOutcome
  readonly selectionFor: PreviewPanelProps['selectionFor']
  readonly comparisons: ReadonlyMap<string, ServerComparison>
  readonly onSelectionChange: PreviewPanelProps['onSelectionChange']
  readonly onEditResource: (fileId: string, key: string, resource: unknown) => void
}): JSX.Element => (
  <section className={styles.fileSection} aria-label={file.picked.fileName}>
    <h3 className={styles.fileHeading}>{file.picked.fileName}</h3>
    {file._tag === 'unreadable' && (
      <p role="alert" className={styles.emptyMessage}>
        {UNREADABLE_FILE_MESSAGE}
      </p>
    )}
    {file._tag === 'unrecognized' && (
      <p role="alert" className={styles.emptyMessage}>
        {UNRECOGNIZED_FILE_MESSAGE}
      </p>
    )}
    {file._tag === 'read' && (
      <ReadFileBody
        file={file}
        selection={selectionFor(file.id)}
        comparisons={comparisons}
        onSelectionChange={(selection) => onSelectionChange(file.id, selection)}
        onEditResource={(key, resource) => onEditResource(file.id, key, resource)}
      />
    )}
  </section>
)

/** The single action row for the whole batch: confirm (when anything is chosen) and cancel. */
const PreviewActions = ({
  writableCount,
  excludedCount,
  onConfirm,
  onCancel,
  confirming,
}: {
  readonly writableCount: number
  readonly excludedCount: number
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
        {confirmLabel(writableCount, excludedCount, confirming)}
      </button>
    )}
  </div>
)

/** The resource-editor dialog's state: closed, or open on one file's resource. */
type EditorState = Data.TaggedEnum<{
  readonly Closed: Record<never, never>
  readonly Open: { readonly fileId: string; readonly key: string; readonly resource: unknown }
}>
const editorState = Data.taggedEnum<EditorState>()
const { Closed: makeClosedEditor, Open: makeOpenEditor } = editorState

/**
 * The preview surface. Renders the batch grouped by format — each format's
 * settings form over its files' sectioned, per-resource reviews — and, when
 * at least one resource is included, the single confirm action that opts
 * into writing the whole batch.
 */
const PreviewPanel = ({
  files,
  settings,
  settingsRegistry,
  selectionFor,
  comparisons,
  onSelectionChange,
  onSettingsChange,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  const [editing, setEditing] = useState<EditorState>(makeClosedEditor())

  const { writableCount, excludedCount } = useMemo(() => {
    let included = 0
    let excluded = 0
    for (const file of files) {
      if (file._tag !== 'read') continue
      const labeled = sectionResources(file.decoded.sections)
      const selection = selectionFor(file.id)
      included += StagedImport.includedCount(labeled, selection)
      excluded += StagedImport.excludedCount(labeled, selection)
    }
    return { writableCount: included, excludedCount: excluded }
  }, [files, selectionFor])

  const openEditor = (fileId: string, key: string, resource: unknown): void => {
    setEditing(makeOpenEditor({ fileId, key, resource }))
  }
  const closeEditor = (): void => setEditing(makeClosedEditor())
  const keepEdit = (resource: FhirResource): void => {
    if (editing._tag !== 'Open') return
    onSelectionChange(
      editing.fileId,
      StagedImport.edit(selectionFor(editing.fileId), editing.key, resource)
    )
    setEditing(makeClosedEditor())
  }

  const formatGroups = formatKinds
    .map((format) => ({
      format,
      files: files.filter(
        (file): file is ReadFile<FormatKind> | UnreadableFile<FormatKind> =>
          file._tag !== 'unrecognized' && file.format === format
      ),
    }))
    .filter((group) => group.files.length > 0)
  const unrecognized = files.filter((file) => file._tag === 'unrecognized')

  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {files.length > 1 && writableCount > 0 && (
        <p role="status" className={styles.batchSummary}>
          {`${writableCount} ${plural(writableCount, 'resource')} across ${files.length} files`}
        </p>
      )}
      <div className={styles.formatGroups}>
        {formatGroups.map((group) => (
          <section
            key={group.format}
            className={styles.formatGroup}
            aria-label={settingsRegistry[group.format].display.title}
          >
            <h3 className={styles.formatHeading}>{settingsRegistry[group.format].display.title}</h3>
            <div className={styles.settingsForm}>
              <FormatSettingsForm
                format={group.format}
                settings={settings}
                settingsRegistry={settingsRegistry}
                onSettingsChange={onSettingsChange}
              />
            </div>
            <div className={styles.fileSections}>
              {group.files.map((file) => (
                <FileSection
                  key={file.id}
                  file={file}
                  selectionFor={selectionFor}
                  comparisons={comparisons}
                  onSelectionChange={onSelectionChange}
                  onEditResource={openEditor}
                />
              ))}
            </div>
          </section>
        ))}
        {unrecognized.map((file) => (
          <FileSection
            key={file.id}
            file={file}
            selectionFor={selectionFor}
            comparisons={comparisons}
            onSelectionChange={onSelectionChange}
            onEditResource={openEditor}
          />
        ))}
      </div>
      <PreviewActions
        writableCount={writableCount}
        excludedCount={excludedCount}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirming={confirming}
      />
      <ResourceEditor
        open={editing._tag === 'Open'}
        resource={editing._tag === 'Open' ? editing.resource : null}
        onEdit={(edit) => keepEdit(edit.resource)}
        onCancel={closeEditor}
      />
    </section>
  )
}

export {
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  type SettingsRegistry,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
}
