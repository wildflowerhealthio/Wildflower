import type { SeriesSource } from '@wildflowerhealthio/health-viewer-fundamentals'

import type { ObservationSeries } from './observation-series.ts'

/**
 * `Observation.category` codes in panel order — roughly how often a reader
 * looks for them. A category outside this list falls into
 * {@link OTHER_GROUP}, never out.
 */
const CATEGORY_ORDER: readonly string[] = [
  'vital-signs',
  'laboratory',
  'exam',
  'survey',
  'imaging',
  'procedure',
  'social-history',
  'therapy',
  'activity',
]

/** Group id for observations whose category is absent or outside {@link CATEGORY_ORDER}. */
const OTHER_GROUP = 'other'

/** Human labels for the category codes, for the panel's headings. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  'vital-signs': 'Vital signs',
  laboratory: 'Laboratory',
  exam: 'Exam',
  survey: 'Survey',
  imaging: 'Imaging',
  procedure: 'Procedure',
  'social-history': 'Social history',
  therapy: 'Therapy',
  activity: 'Activity',
}

/**
 * The catalogue headings observations file under: each category in
 * {@link CATEGORY_ORDER}, then {@link OTHER_GROUP}.
 */
const OBSERVATION_GROUPS: readonly SeriesSource.SeriesGroup[] = [
  ...CATEGORY_ORDER.map((category) => ({
    id: category,
    label: CATEGORY_LABELS[category] ?? category,
  })),
  { id: OTHER_GROUP, label: 'Other' },
]

/** The group an observation series is filed under: its category, or {@link OTHER_GROUP}. */
const observationGroupIdOf = (series: ObservationSeries): string =>
  series.category !== null && CATEGORY_ORDER.includes(series.category)
    ? series.category
    : OTHER_GROUP

export { CATEGORY_ORDER, OBSERVATION_GROUPS, OTHER_GROUP, observationGroupIdOf }
