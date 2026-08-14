import type { JSX } from 'react'

import { BetaForm } from './beta-form.tsx'
import { PhoneMockup } from './phone-mockup.tsx'
import styles from './hero.module.css'

/**
 * The opening pitch: eyebrow, headline (with the accent-italic turn on "put it
 * to work"), supporting copy, the first beta form, and the CSS phone mockup.
 * Collapses to a single centered column at \<=920px.
 */
function Hero(): JSX.Element {
  return (
    <section className={styles['hero']}>
      <div className={styles['hero__content']}>
        <p className={styles['hero__eyebrow']}>A personal health record, and its apps</p>
        <h1 className={styles['hero__title']}>
          Your health record on your phone — and a collection of apps that <em>put it to work.</em>
        </h1>
        <p className={styles['hero__lede']}>
          Wildflower gathers your prescriptions, labs and visits into one record you hold, in the
          same format hospital systems already speak. Around it sits a growing collection of focused
          apps — each does one job well, each works on its own, and each reads only what you grant.
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
