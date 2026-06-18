import type { JSX } from 'react'

import styles from './privacy.module.css'

type Guarantee = {
  readonly id: string
  readonly title: string
  readonly body: string
}

const GUARANTEES: readonly Guarantee[] = [
  {
    id: 'on-device',
    title: 'On-device',
    body: "Your records are stored and served directly from your phone. There's no cloud here.",
  },
  {
    id: 'standards',
    title: 'Modern standards',
    body: 'Built on the Fast Healthcare Interoperability Resources (FHIR R4) standard — the same one mandated by the U.S. Office of the National Coordinator for Health IT.',
  },
  {
    id: 'per-app',
    title: 'Per-app control',
    body: 'Choose exactly which apps and individuals can access what. For many, your data never leaves your device.',
  },
]

/** The privacy band: a headline guarantee plus three supporting points. */
function Privacy(): JSX.Element {
  return (
    <section className={styles['privacy']} id="privacy">
      <div className={styles['privacy__inner']}>
        <h2 className={styles['privacy__title']}>
          Your data never leaves your phone <em>unless you say so.</em>
        </h2>
        <div className={styles['privacy__items']}>
          {GUARANTEES.map((guarantee) => (
            <div key={guarantee.id} className={styles['privacy__item']}>
              <h3 className={styles['privacy__item-title']}>{guarantee.title}</h3>
              <p className={styles['privacy__item-body']}>{guarantee.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export { Privacy }
