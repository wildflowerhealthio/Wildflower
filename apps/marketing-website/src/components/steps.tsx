import type { JSX } from 'react'

import styles from './steps.module.css'

type Step = {
  readonly num: string
  readonly title: string
  readonly body: string
}

const STEPS: readonly Step[] = [
  {
    num: '01',
    title: 'Collect',
    body: 'If you can read it on your phone, Wildflower can keep it — pharmacies, labs, portals, wearables.',
  },
  {
    num: '02',
    title: 'Store',
    body: 'On your device, in the same format hospital systems use, so every source fits together.',
  },
  {
    num: '03',
    title: 'Serve',
    body: 'The apps read from your record instead of starting over — a prescription, a visit, a second opinion.',
  },
]

/** The three-beat "Collect / Store / Serve" explainer. */
function Steps(): JSX.Element {
  return (
    <section className={styles['steps']}>
      {STEPS.map((step) => (
        <div key={step.num} className={styles['steps__item']}>
          <span className={styles['steps__num']}>{step.num}</span>
          <div>
            <h3 className={styles['steps__title']}>{step.title}</h3>
            <p className={styles['steps__text']}>{step.body}</p>
          </div>
        </div>
      ))}
    </section>
  )
}

export { Steps }
