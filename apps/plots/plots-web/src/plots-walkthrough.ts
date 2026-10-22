import { PlotsWalkthroughAnchor } from '@wildflowerhealthio/plots-react'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'

/** The Plots walkthrough's id, naming its record in the page's `localStorage`. */
const PLOTS_WALKTHROUGH_ID = 'plots'

/** The version of {@link PLOTS_WALKTHROUGH_STEPS}; raising it shows the walkthrough again. */
const PLOTS_WALKTHROUGH_VERSION = 1

/**
 * The `data-walkthrough` values of the page's own controls the walkthrough
 * points at; the viewer's regions carry `plots-react`'s `PlotsWalkthroughAnchor`.
 */
const PlotsPageWalkthroughAnchor = {
  patientLine: 'patient-line',
} as const

/**
 * The Plots walkthrough: whose record is open, choosing series, how the chart
 * draws them, then the toolbar's ways to change it. The chart's step shows
 * only while the view is the chart.
 */
const PLOTS_WALKTHROUGH_STEPS: ReadonlyArray<WalkthroughStep> = [
  {
    anchor: PlotsPageWalkthroughAnchor.patientLine,
    title: 'Change patient',
    body: "This line names whose records you're plotting: one patient, or All patients. Select Change patient to choose someone else.",
  },
  {
    anchor: PlotsWalkthroughAnchor.seriesPanel,
    title: 'Series',
    body: 'Check a series to plot it, up to 4 series at once. On a small screen, select Series to open the list.',
  },
  {
    anchor: PlotsWalkthroughAnchor.chart,
    title: 'Value Axes',
    body: 'Your series are plotted here over time. Each has a value axis on the left or right, and series in the same unit with similar values share one.',
  },
  {
    anchor: PlotsWalkthroughAnchor.rangePresets,
    title: 'Range',
    body: 'Choose how much time the plot covers, from All down to the last 24h.',
  },
  {
    anchor: PlotsWalkthroughAnchor.viewSwitch,
    title: 'View',
    body: 'Switch to Table to list the readings by time, or to Scatter to plot two series against each other. Show walkthrough again, at the bottom of the page, brings these steps back.',
  },
]

/**
 * Whether the record page shows the Plots walkthrough, kept in the page's
 * `localStorage`, and how the visitor leaves it or asks for it again.
 *
 * @remarks
 * `useWalkthrough` over {@link PLOTS_WALKTHROUGH_ID} and
 * {@link PLOTS_WALKTHROUGH_VERSION}: it shows on a first visit, while no
 * record for the version is kept, and again on `reopen`, the page's Show
 * walkthrough again button. The page has no router, and a launch drops the
 * URL's query, so the request to show it again is state here rather than a
 * search param.
 */
const usePlotsWalkthrough = (): WalkthroughPrompt =>
  useWalkthrough({
    storage: window.localStorage,
    id: PLOTS_WALKTHROUGH_ID,
    version: PLOTS_WALKTHROUGH_VERSION,
  })

export {
  PLOTS_WALKTHROUGH_ID,
  PLOTS_WALKTHROUGH_STEPS,
  PLOTS_WALKTHROUGH_VERSION,
  PlotsPageWalkthroughAnchor,
  usePlotsWalkthrough,
}
