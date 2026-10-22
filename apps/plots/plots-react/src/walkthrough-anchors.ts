/**
 * The `data-walkthrough` values `PlotsLayout` and `MultiAxisChart` put on the
 * viewer page's controls, for the app's first-run walkthrough to point at.
 *
 * @remarks
 * The components carry them so the app's walkthrough can name these
 * controls without reaching into their markup; the walkthrough itself (its
 * steps, its record, when it shows) is the app's. The series panel's value
 * is on the whole panel, so it marks the docked panel on a wide screen and
 * the `Series (n selected)` disclosure on a narrow one.
 */
const PlotsWalkthroughAnchor = {
  /** The series panel. */
  seriesPanel: 'series-panel',
  /** The range presets. */
  rangePresets: 'range-presets',
  /** The view switch. */
  viewSwitch: 'view-switch',
  /** The chart, with or without series; not the table or the scatter. */
  chart: 'chart',
} as const

export { PlotsWalkthroughAnchor }
