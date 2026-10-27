import type { FormatKind } from '@wildflowerhealthio/importer-core'
import { formatKinds } from '@wildflowerhealthio/importer-core'
import { StagedImport, DecodedFile } from '@wildflowerhealthio/importer-fundamentals'
import { Match, Option } from 'effect'
import { type JSX, useCallback, useMemo, useState } from 'react'

import { ReferentRows } from './identity/referent-rows.tsx'
import {
  CHOOSE_OTHER_FILES_LABEL,
  duplicateReferentMessage,
  REFUSED_OVER_PREVIOUS_HINT,
  SEARCH_ERROR_MESSAGE,
  SEARCHING_SERVER_MESSAGE,
} from './identity/referent-text.ts'
import { useIdentityMap } from './identity/use-identity-map.ts'
import { PreviewPanel } from './preview/preview-panel.tsx'
import { initialExclusionsFor, useServerDiff } from './preview/use-server-diff.ts'
import { formatRegistry } from './registry.ts'
import { ImportResults } from './results/import-results.tsx'
import { useConfirmImport } from './run/use-confirm-import.ts'
import { useImportRun } from './run/use-import-run.ts'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more files, review
 * exactly what they would write (per resource), confirm once to write the
 * included resources, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible: the read half
 * (`SourcePicker` → `useImportRun` → `useIdentityMap` → `PreviewPanel`)
 * writes nothing — each file decodes to resources grouped by format, its own
 * source file among them, that the reviewer can exclude or edit — and only
 * the explicit confirm reaches the write half (`useConfirmImport` — one batch
 * bundle per format, verbatim from the preview, best-effort). A batch may span
 * formats: the picker identifies each file against the registered detectors,
 * `importer-core` groups and decodes by format, and the preview mounts one
 * settings form per format present — a settings change re-decodes that
 * format through `useImportRun.applySettings`. Per-resource selections are
 * keyed by format kind and stable resource key, so they survive a re-decode
 * where the resource does. The identity map sits between the read and the
 * review: the batch is placed on the reviewer's link choices before the
 * server diff, the preview and the confirm see it, so all three see the
 * resources that get written.
 *
 * The slice owns every level of this flow rather than the host app: an app
 * mounts only this screen. Mount it inside the host's router and
 * `QueryClientProvider` — the authed runner and the FHIR client both come
 * from router context via `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while a batch is being read into decoded sections. */
const READING_MESSAGE = 'Reading the files…'

/**
 * The message shown after reading, while the server diff is in flight — the
 * preview waits on it rather than painting rows whose badges pop in a moment
 * later.
 */
const CHECKING_SERVER_MESSAGE = 'Checking the server for existing copies…'

const SERVER_DIFF_ERROR_MESSAGE =
  'Could not check the server for existing copies. Duplicate detection is unavailable — all resources will appear as new.'

/** The registered formats' detectors, in registry (priority) order. */
const registeredDetectors = Object.values(formatRegistry)

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun()
  const confirm = useConfirmImport()

  const [selections, setSelections] = useState<ReadonlyMap<FormatKind, StagedImport.Selection>>(
    new Map()
  )

  const runState = importRun.state
  const batchId = runState._tag === 'ready' ? runState.batchId : 0
  const identity = useIdentityMap(runState._tag === 'ready' ? runState.batch : undefined, batchId)
  const identityState = identity.state
  // The identity map the screen shows: the batch as placed, or, when a
  // re-decode refused it, as it placed before, so the reviewer can undo the change.
  const shown = Match.value(identityState).pipe(
    Match.tag('loading', () => undefined),
    Match.tag('ready', 'error', (mapped) => mapped),
    Match.tag('refused', ({ previous }) => Option.getOrUndefined(previous)),
    Match.exhaustive
  )
  // The placed batch: what the diff classifies, the preview shows and the confirm writes.
  const batch = shown?.placed
  const diff = useServerDiff(batch, batchId)

  const initialSelections = useMemo((): ReadonlyMap<FormatKind, StagedImport.Selection> => {
    if (diff._tag === 'loading' || batch === undefined) return new Map()
    const entries: [FormatKind, StagedImport.Selection][] = []
    for (const kind of formatKinds) {
      const result = batch[kind]
      if (result.files.length === 0) continue
      const labeled = DecodedFile.resources(result.decoded)
      const excluded = initialExclusionsFor(labeled, diff.comparisons.get(kind))
      if (excluded.size > 0) {
        entries.push([kind, { excludedResources: excluded, resourceOverrides: new Map() }])
      }
    }
    return new Map(entries)
  }, [diff, batch])

  const selectionFor = useCallback(
    (format: FormatKind): StagedImport.Selection =>
      selections.get(format) ?? initialSelections.get(format) ?? StagedImport.initial(),
    [selections, initialSelections]
  )

  const onSelectionChange = useCallback(
    (format: FormatKind, selection: StagedImport.Selection): void => {
      setSelections((previous) => new Map(previous).set(format, selection))
    },
    []
  )

  const startOver = (): void => {
    confirm.reset()
    importRun.reset()
    setSelections(new Map())
  }

  if (confirm.state._tag === 'done') {
    return (
      <div className={styles.screen}>
        <ImportResults batch={confirm.state.batch} onStartOver={startOver} />
      </div>
    )
  }

  const confirming = confirm.state._tag === 'confirming'
  // A re-decode or a changed link choice re-classifies the placed batch; until
  // its verdicts land, the pre-exclusions are the previous placement's. A
  // refused batch is never written: the review shown is the one before.
  const confirmBlocked =
    confirming ||
    importRun.redecoding ||
    (diff._tag === 'ready' && diff.refreshing) ||
    identityState._tag === 'refused'

  const body = ((): JSX.Element => {
    if (runState._tag === 'idle')
      return <SourcePicker detectors={registeredDetectors} onPick={importRun.run} />
    if (runState._tag === 'reading') {
      return (
        <p role="status" className={styles.status}>
          {READING_MESSAGE}
        </p>
      )
    }
    // Block the first paint on the identity map's default search, so every
    // referent paints with its search hit already chosen.
    if (identityState._tag === 'loading') {
      return (
        <p role="status" className={styles.status}>
          {SEARCHING_SERVER_MESSAGE}
        </p>
      )
    }
    // A batch the stage refuses on its first decode has nothing to review:
    // say why, and offer the picker again. Refused after a re-decode, the
    // review before it stays up, under the refusal, below.
    if (shown === undefined && identityState._tag === 'refused') {
      return (
        <>
          <p role="alert" className={styles.error}>
            {duplicateReferentMessage(identityState.failure)}
          </p>
          <button type="button" className={styles.back} onClick={startOver}>
            {CHOOSE_OTHER_FILES_LABEL}
          </button>
        </>
      )
    }
    // Block the preview while there is nothing worth showing, so every row
    // paints with its badge already resolved — no mid-render pop-in a second
    // after the panel shows. A settings change keeps the previous batch's
    // verdicts on screen instead of coming back here: blocking on a re-decode
    // would unmount the panel, and the settings input the reviewer is typing
    // into with it.
    if (diff._tag === 'loading' || shown === undefined) {
      return (
        <p role="status" className={styles.status}>
          {CHECKING_SERVER_MESSAGE}
        </p>
      )
    }
    return (
      <>
        {identityState._tag === 'refused' && (
          <p role="alert" className={styles.error}>
            {`${duplicateReferentMessage(identityState.failure)} ${REFUSED_OVER_PREVIOUS_HINT}`}
          </p>
        )}
        {identityState._tag === 'error' && (
          <p role="alert" className={styles.error}>
            {SEARCH_ERROR_MESSAGE}
          </p>
        )}
        {diff._tag === 'error' && (
          <p role="alert" className={styles.error}>
            {SERVER_DIFF_ERROR_MESSAGE}
          </p>
        )}
        <PreviewPanel
          batch={shown.placed}
          settings={importRun.settings}
          settingsRegistry={formatRegistry}
          selectionFor={selectionFor}
          comparisons={diff.comparisons}
          onSelectionChange={onSelectionChange}
          onSettingsChange={importRun.applySettings}
          confirming={confirming}
          confirmDisabled={confirmBlocked}
          onCancel={startOver}
          onConfirm={() => confirm.confirm(shown.placed, selectionFor)}
          referentRows={
            <ReferentRows
              referents={shown.referents}
              linkChoices={shown.linkChoices}
              linkTargets={shown.linkTargets}
              found={shown.found}
              onChoose={identity.choose}
            />
          }
        />
      </>
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { CHECKING_SERVER_MESSAGE, ImporterScreen, READING_MESSAGE, SERVER_DIFF_ERROR_MESSAGE }
