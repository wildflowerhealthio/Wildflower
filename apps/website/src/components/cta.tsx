import type { JSX } from 'react'

import { BetaForm } from './beta-form.tsx'
import styles from './cta.module.css'

/** The closing call to action: a heading beside the second beta form. */
function Cta(): JSX.Element {
  return (
    <section className={styles['cta']} id="invite">
      <div className={styles['cta__heading']}>
        <h2 className={styles['cta__title']}>Request your beta invite.</h2>
        <p className={styles['cta__sub']}>Be among the first to bring your health record home.</p>
      </div>
      <div className={styles['cta__form-wrap']}>
        <BetaForm variant="cta" />
      </div>
    </section>
  )
}

export { Cta }
