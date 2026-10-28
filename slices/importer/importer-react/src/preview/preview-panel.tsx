import type { ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { DecodedFile, StagedImport } from '@wildflowerhealthio/importer-fundamentals'
import { Data } from 'effect'
import { type JSX, type ReactNode, useMemo, useState } from 'react'

import type { FormatKind, FormatSettings, ResolvedBatch } from '@wildflowerhealthio/importer-core'
import {
  claimedFormats,
  formatKinds,
  LINKED_GROUP,
  planBatchWrite,
} from '@wildflowerhealthio/importer-core'

import type { FormatWithComponents } from '../registry.ts'
import { describeResource } from './describe-resource.ts'
import { DiffBadge } from './diff-badge.tsx'
import { FormatReviewBody } from './format-review-body.tsx'
import {
  confirmLabel,
  LINKED_RECORDS_HEADING,
  LINKED_RECORDS_NOTE,
  NOTHING_TO_IMPORT_HEADING,
  plural,
  PREVIEW_HEADING,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-text.ts'
import { ResourceEditor } from './resource-editor.tsx'
import type { GroupComparisons } from './use-server-diff.ts'
import panelStyles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-resource review of exactly what
 * the import would write, shown before anything touches the server, so
 * confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, grouped by format and decoded
 * into one `FormatDecode.Result` per format, rendered together under
 * one confirm. The display is fully general — the same for every format:
 * formats shown under that format's settings form, each format showing its
 * decoded sections (title + per-resource rows with include/edit/revert)
 * and its diagnostic notes, with unreadable files reported rather than
 * sinking the batch. Below the formats, the batch's linked records — the
 * records it names but holds no copy of, as the referent rows link them —
 * are shown with their server diff and no toggle: which are written is
 * `importer-core`'s `planBatchWrite`, which the confirm reads too — a stored
 * copy whenever the server does not hold it unchanged, a new record only
 * when a resource the batch writes names it. A settings change calls
 * `onSettingsChange`; the shell re-decodes that format. The confirm appears
 * only when that plan writes at least one resource, and it does not write —
 * it calls `onConfirm`; the confirm step writes exactly the reviewed objects.
 *
 * @packageDocumentation
 */

/**
 * The registry-shaped structure this panel reads per format: the display
 * strings for the group heading and the `SettingsPicker` for its form.
 */
type SettingsRegistry = {
  readonly [K in FormatKind]: Pick<FormatWithComponents<K>, 'display' | 'SettingsPicker'>
}

type SettingsChangeHandler<K extends FormatKind> = (format: K, settings: FormatSettings[K]) => void

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** The decoded batch, one entry per format plus unrecognized files. */
  readonly batch: ResolvedBatch
  /** The current per-format settings the decodes ran under. */
  readonly settings: FormatSettings
  /** The registered formats' display + settings pickers, indexed by kind. */
  readonly settingsRegistry: SettingsRegistry
  /** The reviewed selection for a format (defaults to `StagedImport.initial()` before any edit). */
  readonly selectionFor: (format: FormatKind) => StagedImport.Selection
  /** The keys of the linked records the server diff found unchanged, which are not written. */
  readonly unchangedLinked: ReadonlySet<string>
  /**
   * Each labeled resource's server comparison (`new` / `unchanged` /
   * `changed`, and for `changed` the leaf-level field diffs), keyed by the
   * group it is reviewed in (a format, or the linked records) and then by
   * `DecodedFile.Resource`'s `key`. Rendered as a badge on each row — the
   * `changed` badge opens to show `field "server" -> "import"` with a
   * per-field reset on a format's row. A key absent from the map (the
   * pre-fetch is still in flight, or the resource is not covered by the
   * classifier) renders no badge.
   */
  readonly comparisons: GroupComparisons
  /** Called when a format's review changes its selection. */
  readonly onSelectionChange: (format: FormatKind, selection: StagedImport.Selection) => void
  /** Called when the user changes one format's settings; the caller re-decodes. */
  readonly onSettingsChange: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  /**
   * Called when the user confirms the batch. Fires only when the batch writes
   * at least one resource; the panel gates the affordance, so a caller can
   * treat this as "the user opted in to writing the batch".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to show the importing label. */
  readonly confirming: boolean
  /** Whether the confirm button should be disabled (confirming or re-decoding). */
  readonly confirmDisabled?: boolean
  /** The identity map's referent rows, rendered above the format groups. */
  readonly referentRows?: ReactNode
}

/** One format's settings form, picked out of the registry by kind. */
const FormatSettingsForm = <TFormat extends FormatKind>({
  kind,
  settings,
  settingsRegistry,
  onSettingsChange,
}: {
  readonly kind: TFormat
  readonly settings: FormatSettings
  readonly settingsRegistry: SettingsRegistry
  readonly onSettingsChange: SettingsChangeHandler<TFormat>
}): JSX.Element => {
  const Picker = settingsRegistry[kind].SettingsPicker

  return <Picker settings={settings[kind]} onChange={(next) => onSettingsChange(kind, next)} />
}

/** The single action row for the whole batch: confirm (when anything is chosen) and cancel. */
const PreviewActions = ({
  writableCount,
  excludedCount,
  onConfirm,
  onCancel,
  confirming,
  disabled,
}: {
  readonly writableCount: number
  readonly excludedCount: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly confirming: boolean
  readonly disabled: boolean
}): JSX.Element => (
  <div className={panelStyles['preview-panel__actions']}>
    <button
      type="button"
      className={panelStyles['preview-panel__cancel']}
      onClick={onCancel}
      disabled={disabled}
    >
      Cancel
    </button>
    {writableCount > 0 && (
      <button
        type="button"
        className={panelStyles['preview-panel__confirm']}
        onClick={onConfirm}
        disabled={disabled}
      >
        {confirmLabel(writableCount, excludedCount, confirming)}
      </button>
    )}
  </div>
)

/**
 * The batch's linked records, read-only: each with its type, its one-line
 * summary and its server diff. Nothing here toggles or edits: a linked record
 * is written as the referent rows link it (`planBatchWrite` decides which
 * are), and changing it means choosing differently there.
 */
const LinkedRecords = ({
  linkedRecords,
  comparisons,
}: {
  readonly linkedRecords: readonly DecodedFile.Resource[]
  readonly comparisons: ReadonlyMap<string, ServerComparison> | undefined
}): JSX.Element => (
  <section
    className={panelStyles['preview-panel__format-group']}
    aria-label={LINKED_RECORDS_HEADING}
  >
    <h3 className={panelStyles['preview-panel__format-heading']}>{LINKED_RECORDS_HEADING}</h3>
    <p className={panelStyles['preview-panel__linked-note']}>{LINKED_RECORDS_NOTE}</p>
    <ul className={panelStyles['preview-panel__linked-list']}>
      {linkedRecords.map((entry) => {
        const description = describeResource(entry.resource)
        return (
          <li key={entry.key} className={panelStyles['preview-panel__linked-row']}>
            <span className={panelStyles['preview-panel__linked-type']}>{description.type}</span>
            <span>{description.summary}</span>
            <DiffBadge comparison={comparisons?.get(entry.key)} current={entry.resource} />
          </li>
        )
      })}
    </ul>
  </section>
)

/** The resource-editor dialog's state: closed, or open on one format's resource. */
type EditorState = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Closed: Record<never, never>
  readonly Open: { readonly format: FormatKind; readonly key: string; readonly resource: unknown }
}>
const editorState = Data.taggedEnum<EditorState>()
const { Closed: makeClosedEditor, Open: makeOpenEditor } = editorState

/**
 * The preview surface. Renders the batch grouped by format — each format's
 * settings form over its decoded sections and per-resource reviews — then
 * its linked records, and, when the batch writes at least one resource, the
 * single confirm action that opts into writing the whole batch.
 */
const PreviewPanel = ({
  batch,
  settings,
  settingsRegistry,
  selectionFor,
  unchangedLinked,
  comparisons,
  onSelectionChange,
  onSettingsChange,
  onConfirm,
  onCancel,
  confirming,
  confirmDisabled = confirming,
  referentRows,
}: PreviewPanelProps): JSX.Element => {
  const [editing, setEditing] = useState<EditorState>(makeClosedEditor())

  const totalFiles = useMemo(
    () =>
      formatKinds.reduce((sum, kind) => sum + batch.formats[kind].files.length, 0) +
      batch.unrecognizedFiles.length,
    [batch]
  )

  // What the confirm would write: the formats' included resources and the
  // linked records the same plan writes beside them.
  const { writableCount, excludedCount } = useMemo(() => {
    const plan = planBatchWrite(batch, selectionFor, unchangedLinked)
    return plan.formats.reduce(
      (counts, { result, plan: formatPlan }) => ({
        writableCount:
          counts.writableCount + (formatPlan._tag === 'write' ? formatPlan.resources.length : 0),
        excludedCount:
          counts.excludedCount +
          StagedImport.excludedCount(
            DecodedFile.resources(result.decoded),
            selectionFor(result.format)
          ),
      }),
      { writableCount: plan.linked.length, excludedCount: 0 }
    )
  }, [batch, selectionFor, unchangedLinked])

  const openEditor = (format: FormatKind, key: string, resource: unknown): void => {
    setEditing(makeOpenEditor({ format, key, resource }))
  }
  const closeEditor = (): void => setEditing(makeClosedEditor())
  const keepEdit = (resource: FhirResourceWithId): void => {
    if (editing._tag !== 'Open') return
    onSelectionChange(
      editing.format,
      StagedImport.edit(selectionFor(editing.format), editing.key, resource)
    )
    setEditing(makeClosedEditor())
  }

  const activeFormats = useMemo(() => claimedFormats(batch.formats), [batch])

  return (
    <section aria-label="Import preview" className={panelStyles['preview-panel']}>
      <h2 className={panelStyles['preview-panel__heading']}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {totalFiles > 1 && writableCount > 0 && (
        <p role="status" className={panelStyles['preview-panel__batch-summary']}>
          {`${writableCount} ${plural(writableCount, 'resource')} across ${totalFiles} files`}
        </p>
      )}
      {referentRows}
      <div className={panelStyles['preview-panel__format-groups']}>
        {activeFormats.map((kind) => {
          const result = batch.formats[kind]
          return (
            <section
              key={kind}
              className={panelStyles['preview-panel__format-group']}
              aria-label={settingsRegistry[kind].display.title}
            >
              <h3 className={panelStyles['preview-panel__format-heading']}>
                {settingsRegistry[kind].display.title}
              </h3>
              <div className={panelStyles['preview-panel__settings-form']}>
                <FormatSettingsForm
                  kind={kind}
                  settings={settings}
                  settingsRegistry={settingsRegistry}
                  onSettingsChange={onSettingsChange}
                />
              </div>
              <div className={panelStyles['preview-panel__file-sections']}>
                <FormatReviewBody
                  result={result}
                  selection={selectionFor(kind)}
                  comparisons={comparisons.get(kind)}
                  onSelectionChange={(selection) => onSelectionChange(kind, selection)}
                  onEditResource={(key, resource) => openEditor(kind, key, resource)}
                />
              </div>
            </section>
          )
        })}
        {batch.linkedRecords.length > 0 && (
          <LinkedRecords
            linkedRecords={batch.linkedRecords}
            comparisons={comparisons.get(LINKED_GROUP)}
          />
        )}
        {batch.unrecognizedFiles.map((file) => (
          <section
            key={file.id}
            className={panelStyles['preview-panel__file-section']}
            aria-label={file.title}
          >
            <h3 className={panelStyles['preview-panel__file-heading']}>{file.title}</h3>
            <p role="alert" className={panelStyles['preview-panel__empty']}>
              {UNRECOGNIZED_FILE_MESSAGE}
            </p>
          </section>
        ))}
      </div>
      <PreviewActions
        writableCount={writableCount}
        excludedCount={excludedCount}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirming={confirming}
        disabled={confirmDisabled}
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

export { PreviewPanel, type PreviewPanelProps, type SettingsRegistry }
