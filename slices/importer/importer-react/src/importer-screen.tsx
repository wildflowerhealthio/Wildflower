import type { FormatKind } from '@wildflowerhealthio/importer-core'
import { claimedFormats, LINKED_GROUP } from '@wildflowerhealthio/importer-core'
import {
  DecodedFile,
  type LinkChoice,
  LinkableResource,
  Referent,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
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
import { useLinkChoiceReview } from './identity/use-link-choice-review.ts'
import { PreviewPanel } from './preview/preview-panel.tsx'
import {
  formatExcludedByDefault,
  unchangedKeysOf,
  useServerDiff,
} from './preview/use-server-diff.ts'
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
 * (`SourcePicker` → `useImportRun` → `useLinkChoiceReview` → `PreviewPanel`)
 * writes nothing — each file decodes to resources grouped by format, its own
 * source file among them, that the reviewer can exclude or edit — and only
 * the explicit confirm reaches the write half (`useConfirmImport` — one
 * transaction for the whole batch, verbatim from the preview, landing whole
 * or not at all). A batch may span
 * formats: the picker identifies each file against the registered detectors,
 * `importer-core` groups and decodes by format, and the preview mounts one
 * settings form per format present — a settings change re-decodes that
 * format through `useImportRun.applySettings`. Per-resource selections are
 * keyed by format kind and stable resource key, so they survive a re-decode
 * where the resource does. The identity map sits between the read and the
 * review: the batch is resolved on the reviewer's link choices before the
 * server diff, the preview and the confirm see it, so all three see the
 * resources that get written. A per-mention pick on a row is a mention link
 * choice in the identity map too, not an edit, and an edit is resolved on
 * the plan as the row it replaces is. The selection holds only what the
 * reviewer did: a row they never ticked or unticked is out by default when
 * the server holds it unchanged or it is left without a patient as it will
 * be written, derived from the batch as it is now, so a link that gives it
 * a patient takes it back in. A referent's link change drops any edit made
 * on a row holding its resource, since that row now writes a different
 * record.
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

/** The selection of a format the reviewer has not touched. */
const UNTOUCHED: StagedImport.Selection = StagedImport.initial()

/** No row out by default: the review before the server diff lands. */
const NONE_BY_DEFAULT: ReadonlySet<string> = new Set()

/**
 * `selection` with the edit dropped on every row of `decodedFile` that holds
 * a copy of `referent`'s decoded resource: its first copy, and every other
 * the referent stands for (`Referent.discover`).
 */
const revertCopiesOf = (
  selection: StagedImport.Selection,
  decodedFile: DecodedFile.DecodedFile,
  referent: Referent.AsResource
): StagedImport.Selection =>
  DecodedFile.resources(decodedFile)
    .filter(({ resource }) =>
      Option.exists(Option.liftPredicate(resource, LinkableResource.is), (linkable) =>
        LinkableResource.sameRecord(linkable, referent.resource)
      )
    )
    .reduce((reverted, { key }) => StagedImport.revert(reverted, key), selection)

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun()
  const confirm = useConfirmImport()

  const [selections, setSelections] = useState<ReadonlyMap<FormatKind, StagedImport.Selection>>(
    new Map()
  )

  const runState = importRun.state
  const batchId = runState._tag === 'ready' ? runState.batchId : 0
  const identity = useLinkChoiceReview(
    runState._tag === 'ready' ? runState.batch : undefined,
    batchId
  )
  const identityState = identity.state
  // The identity map the screen shows: the batch as resolved, or, when a
  // re-decode refused it, as it resolved before, so the reviewer can undo the change.
  const shown = Match.value(identityState).pipe(
    Match.tag('loading', () => undefined),
    Match.tag('ready', 'error', (mapped) => mapped),
    Match.tag('refused', ({ previous }) => Option.getOrUndefined(previous)),
    Match.exhaustive
  )
  // The resolved batch: what the diff classifies, the preview shows and the confirm writes.
  const batch = shown?.resolved
  const diff = useServerDiff(batch, batchId)

  const selectionFor = useCallback(
    (format: FormatKind): StagedImport.Selection => selections.get(format) ?? UNTOUCHED,
    [selections]
  )

  // The linked records the server already holds as they are, which the
  // confirm does not write.
  const unchangedLinked = useMemo(
    (): ReadonlySet<string> =>
      diff._tag === 'loading' || batch === undefined
        ? NONE_BY_DEFAULT
        : unchangedKeysOf(batch.linkedRecords, diff.comparisons.get(LINKED_GROUP)),
    [diff, batch]
  )

  // Each format's rows out unless the reviewer ticks them, derived afresh
  // from the batch, its verdicts and the edits whenever any of them changes.
  const excludedByDefault = useMemo((): ReadonlyMap<FormatKind, ReadonlySet<string>> => {
    if (diff._tag === 'loading' || batch === undefined) return new Map()
    return new Map(
      claimedFormats(batch.formats).map((kind) => [
        kind,
        formatExcludedByDefault(batch, kind, diff.comparisons.get(kind), selectionFor(kind)),
      ])
    )
  }, [diff, batch, selectionFor])

  const excludedByDefaultFor = useCallback(
    (format: FormatKind): ReadonlySet<string> => excludedByDefault.get(format) ?? NONE_BY_DEFAULT,
    [excludedByDefault]
  )

  const onSelectionChange = useCallback(
    (format: FormatKind, selection: StagedImport.Selection): void => {
      setSelections((previous) => new Map(previous).set(format, selection))
    },
    []
  )

  // An edit on a row holding a referent's resource was made on what it
  // linked to then: once the link changes, that row writes another record,
  // so the edit is dropped on every such row in every format rather than
  // written in its place.
  const { choose } = identity
  const referents = shown?.referents
  const decodedBatch = shown?.resolved.decodedBatch
  const chooseLink = useCallback(
    (referentKey: string, choice: LinkChoice.Type): void => {
      choose(referentKey, choice)
      const changed = referents?.find((referent) => Referent.key(referent) === referentKey)
      if (
        changed === undefined ||
        decodedBatch === undefined ||
        !Referent.is('AsResource')(changed)
      )
        return
      setSelections(
        (previous) =>
          new Map(
            [...previous].map(([kind, selection]) => [
              kind,
              revertCopiesOf(selection, decodedBatch.formats[kind].decoded, changed),
            ])
          )
      )
    },
    [choose, referents, decodedBatch]
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
  // A re-decode or a changed link choice re-classifies the resolved batch; until
  // its verdicts land, the unchanged rows are the previous resolving's. A
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
          batch={shown.resolved}
          settings={importRun.settings}
          settingsRegistry={formatRegistry}
          selectionFor={selectionFor}
          excludedByDefaultFor={excludedByDefaultFor}
          unchangedLinked={unchangedLinked}
          comparisons={diff.comparisons}
          onSelectionChange={onSelectionChange}
          onSettingsChange={importRun.applySettings}
          confirming={confirming}
          confirmDisabled={confirmBlocked}
          onCancel={startOver}
          onConfirm={() =>
            confirm.confirm(shown.resolved, selectionFor, excludedByDefaultFor, unchangedLinked)
          }
          mentionLinkOptions={shown.mentionLinkOptions}
          onChooseMention={identity.chooseMention}
          referentRows={
            <ReferentRows
              referents={shown.referents}
              linkChoices={shown.linkChoices}
              plan={shown.resolved.plan}
              found={shown.found}
              disabled={identityState._tag === 'refused'}
              onChoose={chooseLink}
            />
          }
        />
      </>
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { CHECKING_SERVER_MESSAGE, ImporterScreen, READING_MESSAGE, SERVER_DIFF_ERROR_MESSAGE }
