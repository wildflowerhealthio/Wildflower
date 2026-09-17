import { Data } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { DecodedFile, StagedImport } from 'importer-fundamentals'
import { type JSX, useMemo, useState } from 'react'

import type { BatchDecodeResult, FormatKind, FormatSettings } from 'importer-core'
import { claimedFormats, formatKinds } from 'importer-core'

import type { BoundFormat } from '../registry.ts'
import {
  confirmLabel,
  NOTHING_TO_IMPORT_HEADING,
  plural,
  PREVIEW_HEADING,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-text.ts'
import { ReadFileBody } from './read-file-body.tsx'
import { ResourceEditor } from './resource-editor.tsx'
import type { FormatComparisons } from './use-server-diff.ts'
import styles from './preview-panel.module.css'

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
 * sinking the batch. A settings change calls `onSettingsChange`; the shell
 * re-decodes that format. The confirm appears only when at least one
 * resource is included, and it does not write — it calls `onConfirm`;
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

type SettingsChangeHandler<K extends FormatKind> = (format: K, settings: FormatSettings[K]) => void

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** The batch decode result, one entry per format plus unrecognized files. */
  readonly batch: BatchDecodeResult
  /** The current per-format settings the decodes ran under. */
  readonly settings: FormatSettings
  /** The registered formats' display + settings pickers, indexed by kind. */
  readonly settingsRegistry: SettingsRegistry
  /** The reviewed selection for a format (defaults to `StagedImport.initial()` before any edit). */
  readonly selectionFor: (format: FormatKind) => StagedImport.Selection
  /**
   * Each labeled resource's server comparison (`new` / `unchanged` /
   * `changed`, and for `changed` the leaf-level field diffs), keyed by
   * format kind and then by `DecodedFile.Resource`'s `key`. Rendered as a
   * badge on each row — the `changed` badge opens to show
   * `field "server" -> "import"` with a per-field reset. A key absent from
   * the map (the pre-fetch is still in flight, or the resource is not
   * covered by the classifier) renders no badge.
   */
  readonly comparisons: FormatComparisons
  /** Called when a format's review changes its selection. */
  readonly onSelectionChange: (format: FormatKind, selection: StagedImport.Selection) => void
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
  /** Whether a confirmed import is currently running, to show the importing label. */
  readonly confirming: boolean
  /** Whether the confirm button should be disabled (confirming or re-decoding). */
  readonly confirmDisabled?: boolean
}

/**
 * One format's settings form. The registry's construction guarantees the
 * picker's settings type matches `FormatSettings[kind]`; the cast bridges
 * a correlation TypeScript cannot prove through a union-keyed index.
 */
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
  // The registry's typed construction guarantees the picker's TSettings and
  // settings[kind] are the same concrete type for any given kind. TS cannot
  // prove this through a union-keyed index, so we widen the picker to accept
  // any registered format's settings.
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
  <div className={styles.actions}>
    <button type="button" className={styles.cancel} onClick={onCancel} disabled={disabled}>
      Cancel
    </button>
    {writableCount > 0 && (
      <button type="button" className={styles.confirm} onClick={onConfirm} disabled={disabled}>
        {confirmLabel(writableCount, excludedCount, confirming)}
      </button>
    )}
  </div>
)

/** The resource-editor dialog's state: closed, or open on one format's resource. */
type EditorState = Data.TaggedEnum<{
  readonly Closed: Record<never, never>
  readonly Open: { readonly format: FormatKind; readonly key: string; readonly resource: unknown }
}>
const editorState = Data.taggedEnum<EditorState>()
const { Closed: makeClosedEditor, Open: makeOpenEditor } = editorState

/**
 * The preview surface. Renders the batch grouped by format — each format's
 * settings form over its decoded sections and per-resource reviews — and,
 * when at least one resource is included, the single confirm action that
 * opts into writing the whole batch.
 */
const PreviewPanel = ({
  batch,
  settings,
  settingsRegistry,
  selectionFor,
  comparisons,
  onSelectionChange,
  onSettingsChange,
  onConfirm,
  onCancel,
  confirming,
  confirmDisabled = confirming,
}: PreviewPanelProps): JSX.Element => {
  const [editing, setEditing] = useState<EditorState>(makeClosedEditor())

  const totalFiles = useMemo(
    () =>
      formatKinds.reduce((sum, kind) => sum + batch[kind].files.length, 0) +
      batch.unrecognizedFiles.length,
    [batch]
  )

  const { writableCount, excludedCount } = useMemo(() => {
    let included = 0
    let excluded = 0
    for (const kind of claimedFormats(batch)) {
      const labeled = DecodedFile.resources(batch[kind].decoded)
      const selection = selectionFor(kind)
      included += StagedImport.includedCount(labeled, selection)
      excluded += StagedImport.excludedCount(labeled, selection)
    }
    return { writableCount: included, excludedCount: excluded }
  }, [batch, selectionFor])

  const openEditor = (format: FormatKind, key: string, resource: unknown): void => {
    setEditing(makeOpenEditor({ format, key, resource }))
  }
  const closeEditor = (): void => setEditing(makeClosedEditor())
  const keepEdit = (resource: FhirResource): void => {
    if (editing._tag !== 'Open') return
    onSelectionChange(
      editing.format,
      StagedImport.edit(selectionFor(editing.format), editing.key, resource)
    )
    setEditing(makeClosedEditor())
  }

  const activeFormats = useMemo(() => claimedFormats(batch), [batch])

  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {totalFiles > 1 && writableCount > 0 && (
        <p role="status" className={styles.batchSummary}>
          {`${writableCount} ${plural(writableCount, 'resource')} across ${totalFiles} files`}
        </p>
      )}
      <div className={styles.formatGroups}>
        {activeFormats.map((kind) => {
          const result = batch[kind]
          return (
            <section
              key={kind}
              className={styles.formatGroup}
              aria-label={settingsRegistry[kind].display.title}
            >
              <h3 className={styles.formatHeading}>{settingsRegistry[kind].display.title}</h3>
              <div className={styles.settingsForm}>
                <FormatSettingsForm
                  kind={kind}
                  settings={settings}
                  settingsRegistry={settingsRegistry}
                  onSettingsChange={onSettingsChange}
                />
              </div>
              <div className={styles.fileSections}>
                <ReadFileBody
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
        {batch.unrecognizedFiles.map((file) => (
          <section key={file.id} className={styles.fileSection} aria-label={file.title}>
            <h3 className={styles.fileHeading}>{file.title}</h3>
            <p role="alert" className={styles.emptyMessage}>
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
export {
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-text.ts'
