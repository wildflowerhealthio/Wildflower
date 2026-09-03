import type { JSX } from 'react'

import { stepImages } from '../assets/remote-images.ts'
import layout from './layout.module.css'
import styles from './same-language.module.css'

/** Captions for the four consent-flow steps, matched to `stepImages` order. */
const STEP_CAPTIONS = [
  'Select the health provider',
  'Log in with your account',
  'Choose what to share, and for how long',
  'Access your data from the app',
] as const

/**
 * Explains FHIR and SMART on FHIR, then shows the four-step consent flow as
 * a screenshot row — a grid on wide screens, a snap-scrolling horizontal
 * strip under 640px (focusable, with an accessible label, since a scroller
 * must be keyboard-reachable).
 */
function SameLanguage(): JSX.Element {
  return (
    <section className={layout['section']}>
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>What if everything spoke the same language?</h2>
        <div className={layout['prose']}>
          <p>
            Fast Healthcare Interoperability Resources — FHIR — is a standard way for organizations
            to represent and share health information. A specialist could read results directly from
            a lab, share a report with your GP, and send a prescription all with a shared language.
          </p>
          <p>
            In the United States, providers are required to offer patients secure access to their
            records with&nbsp;FHIR. There's no equivalent requirement in Canada.
          </p>
          <p>
            You may have used them already. When you add a hospital to Apple Health, you connect it
            with SMART on FHIR. The same connection could feed any app you trust. Today it's a
            download locked on your phone.
          </p>
        </div>
        <div
          className={styles['steps']}
          role="region"
          aria-label="Connecting a provider, four steps"
          tabIndex={0}
        >
          {stepImages.map((image, index) => (
            <figure className={styles['steps__step']} key={image.src}>
              <img className={styles['steps__image']} src={image.src} alt={image.alt} />
              <figcaption className={styles['steps__caption']}>
                <span className={styles['steps__numeral']}>{index + 1}</span>
                <span>{STEP_CAPTIONS[index]}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}

export { SameLanguage }
