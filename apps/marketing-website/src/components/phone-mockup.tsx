import type { JSX } from 'react'

import { AppIcon } from './app-icon.tsx'
import styles from './phone-mockup.module.css'

/** A source row shown on the mock phone screen, with its dot colour. */
type PhoneRow = {
  readonly id: string
  readonly label: string
  readonly source: string
  readonly dot: 'accent' | 'neutral' | 'success'
}

const ROWS: readonly PhoneRow[] = [
  { id: 'rx', label: 'Prescriptions', source: 'Rexall', dot: 'accent' },
  { id: 'rx-sdm', label: 'Prescriptions', source: 'Shoppers Drug Mart', dot: 'accent' },
  { id: 'labs', label: 'Lab results', source: 'LifeLabs', dot: 'neutral' },
  { id: 'heart', label: 'Heart rate', source: 'Apple Watch', dot: 'success' },
  { id: 'steps', label: 'Steps', source: 'iPhone', dot: 'success' },
]

/**
 * Pure-CSS phone mockup of the app's record screen. Decorative — it
 * restates the surrounding copy visually — so it's hidden from assistive
 * tech.
 */
function PhoneMockup(): JSX.Element {
  return (
    <div className={styles['phone']} aria-hidden="true">
      <div className={styles['phone__screen']}>
        <div className={styles['phone__body']}>
          <div className={styles['phone__brand']}>
            <AppIcon size={28} />
            <span className={styles['phone__brand-name']}>Your record</span>
          </div>
          <p className={styles['phone__label']}>Sources connected</p>
          <ul className={styles['phone__list']}>
            {ROWS.map((row) => (
              <li key={row.id} className={styles['phone__row']}>
                <span className={styles['phone__source']}>
                  <span className={`${styles['phone__dot']} ${styles[`phone__dot--${row.dot}`]}`} />
                  {row.label}
                </span>
                <span className={styles['phone__origin']}>{row.source}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles['phone__footer']}>
          <p className={styles['phone__footer-label']}>Shared with</p>
          <p className={styles['phone__footer-value']}>The apps you choose, one grant at a time</p>
        </div>
      </div>
    </div>
  )
}

export { PhoneMockup }
