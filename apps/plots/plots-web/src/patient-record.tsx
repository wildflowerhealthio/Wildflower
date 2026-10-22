import {
  type PlotView,
  type RangePreset,
  type ScatterAxes,
  type Selection,
  groupForPanel,
  scatterAxesOf,
  shownViewOf,
  xDomain,
} from '@wildflowerhealthio/plots-core-js'
import { Series } from '@wildflowerhealthio/plots-fundamentals'
import {
  PlotsLayout,
  MultiAxisChart,
  RangePresets,
  ScatterChart,
  ScatterUnavailableNote,
  SeriesPanel,
  SeriesTable,
  ViewSwitch,
  useColourSlots,
} from '@wildflowerhealthio/plots-react'
import { LinkButton } from '@wildflowerhealthio/react-tundraish'
import { LoadingLine, LoadingMoreLine, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { Walkthrough } from '@wildflowerhealthio/walkthrough-react'
import type { DateTime } from 'effect'
import { Match, Option } from 'effect'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo } from 'react'

import { PLOTS_WALKTHROUGH_STEPS, usePlotsWalkthrough } from './plots-walkthrough.ts'
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
 * What {@link useShownView} decides about the view the selection asks for:
 * the view on screen, carrying the scatter's series when it is the scatter.
 */
type ShownView = {
  /** Which series a scatter of the selection plots, or why it can't be drawn. */
  readonly scatterAxes: ScatterAxes
} & (
  | { readonly view: 'chart' | 'table' }
  | {
      readonly view: 'scatter'
      readonly x: Series.ValueSeries
      readonly y: Series.ValueSeries
    }
)

/**
 * The view to show for `selection`: core's `shownViewOf` over
 * `scatterAxesOf`, with the scatter's series looked up in the record.
 *
 * @remarks
 * A scatter whose series the record doesn't hold — a source still paging,
 * or a link shared from another patient's record — shows the chart, as a
 * scatter the selection can't make does.
 */
const useShownView = (
  selection: Selection,
  seriesById: ReadonlyMap<string, Series.Series>
): ShownView => {
  const scatterAxes = useMemo(() => scatterAxesOf(selection.series), [selection.series])
  const scatterSeries = useMemo(() => {
    if (scatterAxes.kind !== 'paired') return Option.none()
    const valueSeriesOf = (seriesId: string): Option.Option<Series.ValueSeries> =>
      Option.fromNullable(seriesById.get(seriesId)).pipe(Option.filter(Series.isValueSeries))
    return Option.all({
      x: valueSeriesOf(scatterAxes.xSeriesId),
      y: valueSeriesOf(scatterAxes.ySeriesId),
    })
  }, [scatterAxes, seriesById])
  const view = shownViewOf(selection.view, scatterAxes)
  if (view !== 'scatter') return { view, scatterAxes }
  return Option.match(scatterSeries, {
    onNone: (): ShownView => ({ view: 'chart', scatterAxes }),
    onSome: ({ x, y }): ShownView => ({ view: 'scatter', x, y, scatterAxes }),
  })
}

/**
 * The record as the reader sees it: the series panel, the range presets, the
 * view switch and the selected series in the shown view — the chart, the
 * table or the scatter — with the read's status beside them and what the
 * read left out under the view.
 *
 * @remarks
 * The page only composes: `groupForPanel` for the panel, the selected point
 * and level series as the chart's series, the selected span series as its
 * lanes, `xDomain` for every view's window, {@link useShownView} for which
 * view is on screen, and `useColourSlots` for the colour each value series
 * keeps across views.
 *
 * Once the record is complete, selected ids it holds no series for — a link
 * shared from another patient's record — are dropped from the selection; not
 * before, or a series on a later page would be lost.
 *
 * The Plots walkthrough ({@link usePlotsWalkthrough}) mounts here, once every
 * source has its first page, so it doesn't start over the loading line. It
 * shows on a first visit, and again from Show walkthrough again in the footer
 * under the view; the app has no settings or menu to hold that button.
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
  const valueSeries = useMemo(() => selectedSeries.filter(Series.isValueSeries), [selectedSeries])
  // Kept here, above the view switch, so changing views never repaints a series.
  const colours = useColourSlots(valueSeries)
  const shownView = useShownView(selection, seriesById)
  const lanes = useMemo(() => selectedSeries.filter(Series.isSpanSeries), [selectedSeries])
  const viewTimeDomain = useMemo(
    () => xDomain(selection.range, openedAt, Series.extentOfAll(selectedSeries)),
    [selection.range, openedAt, selectedSeries]
  )

  const changeSelectedSeries = useCallback(
    (selectedSeriesIds: readonly string[]) => {
      onSelectionUpdate((latestSelection) => ({ ...latestSelection, series: selectedSeriesIds }))
    },
    [onSelectionUpdate]
  )
  const changeView = useCallback(
    (view: PlotView) => {
      onSelectionUpdate((latestSelection) => ({ ...latestSelection, view }))
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
  const walkthrough = usePlotsWalkthrough()

  return (
    <>
      <PlotsLayout
        seriesPanel={
          <SeriesPanel
            catalogGroups={catalogGroups}
            selectedSeriesIds={selection.series}
            onSelectionChange={changeSelectedSeries}
          />
        }
        selectedSeriesCount={selection.series.length}
        rangePresets={
          <RangePresets selectedPreset={selection.range} onPresetChange={changeRange} />
        }
        viewSwitch={
          <ViewSwitch
            shownView={shownView.view}
            scatterAxes={shownView.scatterAxes}
            onViewChange={changeView}
          />
        }
        toolbarNote={<ScatterUnavailableNote scatterAxes={shownView.scatterAxes} />}
        status={statusLines.length === 0 ? null : statusLines}
      >
        {Match.value(shownView).pipe(
          Match.when({ view: 'chart' }, () => (
            <MultiAxisChart
              series={valueSeries}
              colours={colours}
              lanes={lanes}
              xDomain={viewTimeDomain}
            />
          )),
          Match.when({ view: 'table' }, () => (
            <SeriesTable series={selectedSeries} timeWindow={viewTimeDomain} />
          )),
          Match.when({ view: 'scatter' }, ({ x, y }) => (
            <ScatterChart x={x} y={y} timeWindow={viewTimeDomain} colours={colours} />
          )),
          Match.exhaustive
        )}
        {leftOutNotes.length > 0 && <p className={styles.note}>{leftOutNotes.join(' · ')}</p>}
      </PlotsLayout>
      <footer className={styles.footer}>
        <LinkButton className="text-body-3" onClick={walkthrough.reopen}>
          Show walkthrough again
        </LinkButton>
      </footer>
      <Walkthrough
        steps={PLOTS_WALKTHROUGH_STEPS}
        open={walkthrough.open}
        onFinish={walkthrough.finish}
        onSkip={walkthrough.skip}
        onPostpone={walkthrough.postpone}
      />
    </>
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
