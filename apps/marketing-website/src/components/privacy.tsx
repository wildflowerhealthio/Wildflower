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
    body: 'Your records are stored and served directly from your phone. Our relay lets the apps and people you choose connect to it, but we never see your data ourselves.',
  },
  {
    id: 'standards',
    title: 'Open standards',
    body: 'Built on Fast Healthcare Interoperability Resources (FHIR R4) — the same standard modern EHRs speak, so your record fits the rest of health care without a translation layer.',
  },
  {
    id: 'per-app',
    title: 'Per-app control',
    body: 'Each app in the collection asks for the resource types it needs, and nothing else. You grant them one at a time, and you can take a grant back.',
  },
]

/** The privacy band: a headline guarantee plus three supporting points. */
function Privacy(): JSX.Element {
  return (
    <section className={styles['privacy']} id="privacy">
      <div className={styles['privacy__inner']}>
        <h2 className={styles['privacy__title']}>
          Your data never leaves your phone
          <br />
          <em>until you say so.</em>
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
