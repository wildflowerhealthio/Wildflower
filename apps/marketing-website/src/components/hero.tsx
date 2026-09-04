import { useEffect, useState, type JSX } from 'react'

import { otherAppImages } from '../assets/remote-images.ts'
import styles from './hero.module.css'

/** How long each "other app" screenshot holds before the phone swipes on. */
const SWIPE_INTERVAL_MS = 3800

/** The staccato lines under the manifesto title, grouped into stanzas. */
const HERO_STANZAS: readonly (readonly string[])[] = [
  [
    'Nine different websites store my health information.',
    'They all want to be the one place for all my health needs.',
  ],
  [
    'I can store my vaccination history in five of them.',
    'Storing history is the only vaccination related feature.',
  ],
  [
    'I built the vaccination history tool in one of them.',
    "I don't store my vaccination history in any of them.",
  ],
  ['My vaccination history is a JPEG attached to an email from my mom.'],
]

/**
 * The opening banner: the manifesto title, the staccato stanzas that set up
 * the essay, and — from 1024px up — a minimal outlined phone lazily swiping
 * through screenshots of the "other apps" the stanzas describe. The phone
 * disappears below 1024px so the stanzas own narrow screens.
 */
function Hero(): JSX.Element {
  return (
    <section className={styles['hero']} id="top">
      <div className={styles['hero__inner']}>
        <h2 className={styles['hero__title']}>
          Patients <i>deserve</i> health data freedom
        </h2>
        <div className={styles['hero__body']}>
          <div className={styles['hero__lines']}>
            {HERO_STANZAS.map((stanza) => (
              <div key={stanza[0]} className={styles['hero__stanza']}>
                {stanza.map((line) => (
                  <p key={line} className={styles['hero__line']}>
                    {line}
                  </p>
                ))}
              </div>
            ))}
          </div>
          <OtherAppsPhone />
        </div>
      </div>
    </section>
  )
}

/**
 * A minimal outlined phone frame lazily swiping through the nine
 * "other apps" screenshots. The images sit in a flex row that shifts
 * `-100%` per step; CSS transitions carry the swipe. Under
 * `prefers-reduced-motion` the phone holds on the first screenshot.
 *
 * `prefers-reduced-motion` is sampled once at mount via a lazy initializer,
 * which is enough for a decorative animation and keeps the effect free of a
 * synchronous `setState`.
 */
function OtherAppsPhone(): JSX.Element {
  const [reducedMotion] = useState(prefersReducedMotion)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (reducedMotion) return undefined
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % otherAppImages.length)
    }, SWIPE_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [reducedMotion])

  return (
    <div className={styles['hero__phone']} aria-hidden="true">
      <div className={styles['hero__phone-frame']}>
        <div
          className={styles['hero__phone-strip']}
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {otherAppImages.map((image) => (
            <img
              key={image.src}
              className={styles['hero__phone-image']}
              src={image.src}
              alt={image.alt}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Whether the viewer has asked for reduced motion (false in non-browser environments). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export { Hero }
