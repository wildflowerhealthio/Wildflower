import type { DateTime } from 'effect'
import { Match } from 'effect'
import { type RangePreset, type Selection, groupForPanel, xDomain } from 'health-viewer-core-js'
import { Series, ValueAxis } from 'health-viewer-fundamentals'
import { HealthViewerLayout, MultiAxisChart, RangePresets, SeriesPanel } from 'health-viewer-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo } from 'react'
import { LoadingLine, LoadingMoreLine, ReadFailureLine } from 'smart-app-react'

import type { SmartClient } from './smart-client.ts'
import { type RecordRead, useRecordRead } from './use-record-read.ts'
import type { SelectionUpdate } from './use-url-selection.ts'
import styles from './app.module.css'

/** `amount` with its noun, pluralised with a plain `s`. */
const formatCount = (amount: number, noun: string): string =>
  `${amount} ${amount === 1 ? noun : `${noun}s`}`

/** What the chart left out, as the notes under it: undated, then unreadable. */
const leftOutNotesOf = (undatedCount: number, unreadableCount: number): readonly string[] => [
  ...(undatedCount > 0 ? [`${formatCount(undatedCount, 'undated record')} skipped`] : []),
  ...(unreadableCount > 0 ? [`${formatCount(unreadableCount, 'record')} couldn't be read`] : []),
]

/** Props shared by {@link PatientRecord} and {@link RecordView}: the selection and its window. */
interface SelectionProps {
  /** The selection as the page last committed it. */
  readonly selection: Selection
  /** Apply a change to the latest selection. */
  readonly onSelectionUpdate: (update: SelectionUpdate) => void
  /** The right edge of every bounded range: the instant the page opened. */
  readonly openedAt: DateTime.Utc
}

/** Props for {@link RecordView}. */
interface RecordViewProps extends SelectionProps {
  /** The record read, once every source has a page. */
  readonly record: Extract<RecordRead, { readonly kind: 'read' }>
}

/**
 * The record as the reader sees it: the series panel, the range presets and
 * the chart of the selected series, with the read's status beside them and
 * what the chart left out under it.
 *
 * @remarks
 * The page only composes: `groupForPanel` for the panel, `ValueAxis.assign`
 * for the chart's axes, `xDomain` for its window.
 *
 * Once the record is complete, selected ids it holds no series for — a link
 * shared from another patient's record — are dropped from the selection; not
 * before, or a series on a later page would be lost.
 */
const RecordView = ({
  record,
  selection,
  onSelectionUpdate,
  openedAt,
}: RecordViewProps): JSX.Element => {
  const { reading, isComplete } = record
  const catalogGroups = useMemo(() => groupForPanel(reading.filed), [reading])
  const seriesById = useMemo(
    () => new Map(reading.filed.map(({ series }) => [series.id, series])),
    [reading]
  )

  // An updater over the latest selection that returns it unchanged when
  // nothing is dropped, so it re-renders and writes the URL only when it must.
  useEffect(() => {
    if (!isComplete) return
    onSelectionUpdate((latestSelection) => {
      const heldSeriesIds = latestSelection.series.filter((seriesId) => seriesById.has(seriesId))
      return heldSeriesIds.length === latestSelection.series.length
        ? latestSelection
        : { ...latestSelection, series: heldSeriesIds }
    })
  }, [isComplete, seriesById, onSelectionUpdate])

  const selectedSeries = useMemo(
    () =>
      selection.series.flatMap((seriesId) => {
        const series = seriesById.get(seriesId)
        return series === undefined ? [] : [series]
      }),
    [selection.series, seriesById]
  )
  const axes = useMemo(() => ValueAxis.assign(selectedSeries), [selectedSeries])
  const chartTimeDomain = useMemo(
    () => xDomain(selection.range, openedAt, Series.extentOfAll(selectedSeries)),
    [selection.range, openedAt, selectedSeries]
  )

  const changeSelectedSeries = useCallback(
    (selectedSeriesIds: readonly string[]) => {
      onSelectionUpdate((latestSelection) => ({ ...latestSelection, series: selectedSeriesIds }))
    },
    [onSelectionUpdate]
  )
  const changeRange = useCallback(
    (range: RangePreset) => {
      onSelectionUpdate((latestSelection) => ({ ...latestSelection, range }))
    },
    [onSelectionUpdate]
  )

  const statusLines = [
    ...(record.isLoadingMore ? [<LoadingMoreLine key="loading-more" />] : []),
    ...record.pageFailures.map(({ subject, error }) => (
      <ReadFailureLine key={subject} subject={subject} error={error} />
    )),
  ]
  const leftOutNotes = leftOutNotesOf(record.undatedCount, record.unreadableCount)

  return (
    <HealthViewerLayout
      seriesPanel={
        <SeriesPanel
          catalogGroups={catalogGroups}
          selectedSeriesIds={selection.series}
          onSelectionChange={changeSelectedSeries}
        />
      }
      selectedSeriesCount={selection.series.length}
      rangePresets={<RangePresets selectedPreset={selection.range} onPresetChange={changeRange} />}
      status={statusLines.length === 0 ? null : statusLines}
    >
      <MultiAxisChart axes={axes} xDomain={chartTimeDomain} />
      {leftOutNotes.length > 0 && <p className={styles.note}>{leftOutNotes.join(' · ')}</p>}
    </HealthViewerLayout>
  )
}

/** Props for {@link PatientRecord}. */
interface PatientRecordProps extends SelectionProps {
  /** The SMART client the record is read through. */
  readonly client: SmartClient
  /** The patient whose record is read, or `null` for every patient's together. */
  readonly patientId: string | null
}

/**
 * A patient's record — or every patient's, read unscoped and charted
 * together: `Loading…` until every source has a page, the failed read's line
 * if a first page fails, and {@link RecordView} from then on, re-rendering as
 * later pages land.
 */
const PatientRecord = ({
  client,
  patientId,
  ...selectionProps
}: PatientRecordProps): JSX.Element => {
  const recordRead = useRecordRead(client, patientId)
  return Match.value(recordRead).pipe(
    Match.when({ kind: 'loading' }, () => <LoadingLine />),
    Match.when({ kind: 'failed' }, ({ failure }) => (
      <ReadFailureLine subject={failure.subject} error={failure.error} />
    )),
    Match.when({ kind: 'read' }, (record) => <RecordView record={record} {...selectionProps} />),
    Match.exhaustive
  )
}

export { PatientRecord }
