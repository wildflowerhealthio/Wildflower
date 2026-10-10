import type { SeriesSource } from '@wildflowerhealthio/health-viewer-fundamentals'

/** The one catalogue group every medication series is filed under. */
const MEDICATIONS_GROUP = 'medications'

/** The catalogue headings medications file under: just {@link MEDICATIONS_GROUP}. */
const MEDICATION_GROUPS: readonly SeriesSource.SeriesGroup[] = [
  { id: MEDICATIONS_GROUP, label: 'Medications' },
]

/**
 * The group a medication series is filed under — always
 * {@link MEDICATIONS_GROUP}, so it reads nothing off the series.
 */
const medicationGroupIdOf = (): string => MEDICATIONS_GROUP

export { MEDICATION_GROUPS, MEDICATIONS_GROUP, medicationGroupIdOf }
