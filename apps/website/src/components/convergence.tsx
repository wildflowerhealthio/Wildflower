import { useState } from 'react'
import type { JSX } from 'react'

import {
  CONNECT_APPS,
  DEFAULT_APP,
  isSourceActive,
  isTypeActive,
  RECORD_SOURCES,
  TYPE_LABELS,
} from '../data/convergence.ts'
import type { AppId } from '../data/convergence.ts'
import { AppIcon } from './app-icon.tsx'
import styles from './convergence.module.css'

/** Join class names, dropping the modifier when the state is off. */
const cx = (base: string, modifier: string | false): string =>
  modifier ? `${base} ${modifier}` : base

/**
 * The "how it works" demo. A single `selectedApp` state drives everything:
 * the chosen app card highlights, its readable chips turn plum, and any
 * source row sharing one of those types stays lit while the rest dim.
 *
 * When the layout stacks (\<=920px) the app cards become a sticky,
 * horizontally scrolling pill rail pinned under the header, with the
 * selected app's pitch shown beneath — see `convergence.module.css`.
 */
function Convergence(): JSX.Element {
  const [selectedApp, setSelectedApp] = useState<AppId>(DEFAULT_APP)
  const selectedPitch = CONNECT_APPS.find((app) => app.id === selectedApp)?.pitch ?? ''

  return (
    <section className={styles['convergence']} id="how">
      <div className={styles['convergence__inner']}>
        <div className={styles['convergence__head']}>
          <h2 className={styles['convergence__title']}>
            Stop logging into five apps to do one thing. <em>Do it in one place.</em>
          </h2>
          <p className={styles['convergence__lede']}>
            Wildflower keeps information from every source in your personal health record — so
            whatever you need to do with it can happen in one place.
          </p>
        </div>

        <div className={styles['convergence__grid']}>
          <div className={styles['record']}>
            <div className={styles['record__header']}>
              <div className={styles['record__brand']}>
                <AppIcon size={30} />
                <span className={styles['record__title']}>Your standardized record</span>
              </div>
              <span className={styles['record__count']}>4 sources</span>
            </div>
            <p className={styles['record__sub']}>
              Every source, normalized into shared resource types.
            </p>

            {RECORD_SOURCES.map((source) => (
              <div
                key={source.id}
                className={cx(
                  styles['record__row'],
                  !isSourceActive(selectedApp, source) && styles['record__row--dim']
                )}
              >
                <div className={styles['record__source']}>
                  <span className={styles['record__source-name']}>{source.name}</span>
                  <span className={styles['record__source-category']}>{source.category}</span>
                </div>
                <div className={styles['record__chips']}>
                  {source.chips.map((type) => (
                    <span
                      key={type}
                      className={cx(
                        styles['chip'],
                        isTypeActive(selectedApp, type) && styles['chip--active']
                      )}
                    >
                      {TYPE_LABELS[type]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={styles['apps']}>
            <p className={styles['apps__label']}>Apps you connect</p>
            <p className={styles['apps__sub']}>
              Each reads only what you grant. Tap one to trace it across your sources.
            </p>
            <div className={styles['apps__list']} role="group" aria-label="Apps you connect">
              {CONNECT_APPS.map((app) => {
                const selected = app.id === selectedApp
                return (
                  <button
                    key={app.id}
                    type="button"
                    aria-pressed={selected}
                    className={cx(styles['app-card'], selected && styles['app-card--active'])}
                    onClick={() => {
                      setSelectedApp(app.id)
                    }}
                  >
                    <span className={styles['app-card__title']}>{app.title}</span>
                    <span className={styles['app-card__pitch']}>{app.pitch}</span>
                    <span className={styles['app-card__reads']}>
                      READS · {app.reads.map((type) => TYPE_LABELS[type]).join(' · ')}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className={styles['apps__pitch']}>{selectedPitch}</p>
          </div>
        </div>

        <p className={styles['convergence__footnote']}>
          gathered under your control · served on modern data standards (FHIR)
        </p>
      </div>
    </section>
  )
}

export { Convergence }
