import type { JSX } from 'react'

import { type SponsoredDrug, type SponsorProgram, sponsorProgramLabels } from 'sponsorship-core'

import styles from './sponsor-chip.module.css'

interface SponsorChipProps {
  readonly sponsor: SponsorProgram
  readonly drug: SponsoredDrug
}

/**
 * A compact green eligibility chip for a medication a sponsor covers in the
 * selected province: the program label followed by "Eligible" (e.g. "innoviCares
 * Eligible"). The whole chip links to the program's coverage page when the
 * matched drug carries a URL. Rendered only for sponsored medications — there is
 * no "not sponsored" chip and no logo.
 */
export const SponsorChip = ({ sponsor, drug }: SponsorChipProps): JSX.Element => {
  const label = `${sponsorProgramLabels[sponsor]} Eligible`
  return drug.url === undefined ? (
    <span className={styles.chip}>{label}</span>
  ) : (
    <a className={styles.chip} href={drug.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  )
}

export type { SponsorChipProps }
