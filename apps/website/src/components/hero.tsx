import type { JSX } from 'react'

import { BetaForm } from './beta-form.tsx'
import { PhoneMockup } from './phone-mockup.tsx'
import styles from './hero.module.css'

/**
 * The opening pitch: eyebrow, headline (with the magenta-italic turn on
 * "None of them is yours."), supporting copy, the first beta form, and the
 * CSS phone mockup. Collapses to a single centered column at \<=920px.
 */
function Hero(): JSX.Element {
  return (
    <section className={styles['hero']}>
      <div className={styles['hero__content']}>
        <p className={styles['hero__eyebrow']}>Your personal health record</p>
        <h1 className={styles['hero__title']}>
          Every clinic keeps a record of you. <em>None of them is yours.</em>
        </h1>
        <p className={styles['hero__lede']}>
          Doctors, labs, and pharmacies each keep the slice of you they saw. Wildflower unifies all
          of it into one personal health record you own and control — on your phone, yours for life,
          across every provider you&rsquo;ll ever have.
        </p>
        <BetaForm variant="hero" />
        <p className={styles['hero__fineprint']}>
          iPhone &amp; Android · invites rolling out gradually
        </p>
      </div>
      <div className={styles['hero__device']}>
        <PhoneMockup />
      </div>
    </section>
  )
}

export { Hero }
