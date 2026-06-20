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
        <p className={styles['hero__eyebrow']}>How many things do you log in to for your health?</p>
        <h1 className={styles['hero__title']}>
          Do your personal health records actually feel <em>personal?</em>
        </h1>
        <p className={styles['hero__lede']}>
          Doctors, labs, and pharmacies all have apps and websites, but they don't tell the whole
          story. Wildflower is a personal health record built on the same open standards as hospital
          EHRs. It makes it easy to see all your health data in one place, share it with the people
          you trust, and take control of your health.
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
