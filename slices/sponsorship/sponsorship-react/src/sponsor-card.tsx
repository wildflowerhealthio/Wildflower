import type { JSX } from 'react'

import type { SponsoredDrug } from 'sponsorship-core'

import styles from './sponsor-card.module.css'

interface SponsorCardProps {
  readonly drug: SponsoredDrug
}

/**
 * A compact card for the sponsored drug a medication matched. Renders the
 * plain-text brand name (never the raw `brandHtml`, to avoid injecting markup),
 * the generic name, an optional logo, and a coverage link when present.
 */
export const SponsorCard = ({ drug }: SponsorCardProps): JSX.Element => {
  const logo = drug.imageUrl ?? drug.logoDataUri
  return (
    <div className={styles.card}>
      {logo !== undefined && <img className={styles.logo} src={logo} alt="" />}
      <div className={styles.body}>
        <span className={styles.brand}>{drug.brandName}</span>
        {drug.genericName.length > 0 && <span className={styles.generic}>{drug.genericName}</span>}
        {drug.url !== undefined && (
          <a className={styles.link} href={drug.url} target="_blank" rel="noreferrer">
            Coverage details
          </a>
        )}
      </div>
    </div>
  )
}

export type { SponsorCardProps }
