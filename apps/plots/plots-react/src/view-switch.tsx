import { SegmentedToggle, type SegmentedToggleOption } from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import { PLOT_VIEWS, type PlotView, type ScatterAxes } from '@wildflowerhealthio/plots-core-js'

import styles from './view-switch.module.css'

/** What each view's button reads. A `Record` so a new view is a type error here. */
const VIEW_LABELS: Readonly<Record<PlotView, string>> = {
  chart: 'Chart',
  table: 'Table',
  scatter: 'Scatter',
}

interface ViewSwitchProps {
  /** The view the page shows. */
  readonly shownView: PlotView
  /** Which series a scatter would plot, or why it can't; Scatter is disabled unless `'paired'`. */
  readonly scatterAxes: ScatterAxes
  /** Called with the view whose button was pressed. */
  readonly onViewChange: (view: PlotView) => void
}

/**
 * The view picker: one `aria-pressed` button per `PLOT_VIEWS` entry, the
 * shown one pressed, and Scatter disabled while the selection can't make one
 * — {@link ScatterUnavailableNote} says why, above the toolbar.
 */
const ViewSwitch = ({ shownView, scatterAxes, onViewChange }: ViewSwitchProps): JSX.Element => {
  const options: readonly SegmentedToggleOption<PlotView>[] = PLOT_VIEWS.map((view) => ({
    value: view,
    label: VIEW_LABELS[view],
    ...(view === 'scatter' && scatterAxes.kind !== 'paired' ? { disabled: true } : {}),
  }))
  return (
    <SegmentedToggle
      value={shownView}
      options={options}
      onChange={onViewChange}
      aria-label="View"
    />
  )
}

/** Why the selection can't make a scatter, or nothing when it can. */
const scatterUnavailableReason = (scatterAxes: ScatterAxes): Option.Option<string> =>
  Match.value(scatterAxes).pipe(
    Match.when({ kind: 'paired' }, () => Option.none()),
    Match.when({ kind: 'too-few-value-series', valueSeriesCount: 0 }, () =>
      Option.some('Scatter needs two series selected')
    ),
    Match.when({ kind: 'too-few-value-series' }, () =>
      Option.some('Scatter needs one more series selected')
    ),
    Match.when({ kind: 'too-many-value-series' }, () =>
      Option.some('Scatter needs only two series selected')
    ),
    Match.exhaustive
  )

interface ScatterUnavailableNoteProps {
  /** Which series a scatter would plot, or why it can't. */
  readonly scatterAxes: ScatterAxes
}

/**
 * Why {@link ViewSwitch}'s Scatter button is disabled, as a status line — or
 * nothing while it is enabled. It sits above the toolbar, never below it.
 */
const ScatterUnavailableNote = ({ scatterAxes }: ScatterUnavailableNoteProps): JSX.Element | null =>
  scatterUnavailableReason(scatterAxes).pipe(
    Option.map((reason) => (
      <p key="scatter-unavailable" className={styles['view-switch__note']} role="status">
        {reason}
      </p>
    )),
    Option.getOrNull
  )

export { ScatterUnavailableNote, ViewSwitch }
export type { ScatterUnavailableNoteProps, ViewSwitchProps }
