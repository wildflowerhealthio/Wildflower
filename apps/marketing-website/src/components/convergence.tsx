import { useState } from 'react'
import type { JSX } from 'react'

import { AppIcon } from 'branding-react'
import {
  AVAILABILITY_LABELS,
  CONNECT_APPS,
  DEFAULT_APP,
  isSourceActive,
  isTypeActive,
  RECORD_SOURCES,
  TYPE_LABELS,
} from '../data/convergence.ts'
import type { AppId } from '../data/convergence.ts'
import styles from './convergence.module.css'

/** Join class names, dropping the modifier when the state is off. */
const cx = (base: string, modifier: string | false): string =>
  modifier ? `${base} ${modifier}` : base

/**
 * The collection section. A single `selectedApp` state drives everything: the
 * chosen app's pill fills, the chips it reads light up, any source row sharing
 * one of those types stays lit while the rest dim, and the detail beneath the
 * rail describes that app — including a link to it when it is published here.
 */
function Convergence(): JSX.Element {
  const [selectedApp, setSelectedApp] = useState<AppId>(DEFAULT_APP)
  const selected = CONNECT_APPS.find((app) => app.id === selectedApp) ?? CONNECT_APPS[0]

  return (
    <section className={styles['convergence']} id="how">
      <div className={styles['convergence__inner']}>
        <div className={styles['convergence__head']}>
          <h2 className={styles['convergence__title']}>
            A collection of apps that work well together — and <em>stand alone.</em>
          </h2>
          <p className={styles['convergence__lede']}>
            One record, gathered from every source you already use. Each app reads only the part of
            it you grant, does one job well, and is useful on its own.
          </p>
        </div>

        <div className={styles['convergence__grid']}>
          <div className={`${styles['record']} card`}>
            <div className={styles['record__header']}>
              <div className={styles['record__brand']}>
                <AppIcon size={30} />
                <span className={styles['record__title']}>Your record</span>
              </div>
              <span className={styles['record__count']}>{RECORD_SOURCES.length} sources</span>
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
            <p className={styles['apps__label']}>The collection</p>
            <div className={styles['apps__list']} role="group" aria-label="Apps in the collection">
              {CONNECT_APPS.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  aria-pressed={app.id === selectedApp}
                  className={`button-2 ${app.id === selectedApp ? 'filled' : 'outline'} ${styles['app-pill']}`}
                  onClick={() => {
                    setSelectedApp(app.id)
                  }}
                >
                  {app.title}
                </button>
              ))}
            </div>

            <div className={styles['apps__detail']}>
              <p className={styles['apps__availability']}>
                {AVAILABILITY_LABELS[selected.availability]}
              </p>
              <p className={styles['apps__pitch']}>{selected.pitch}</p>
              <p className={styles['apps__reads']}>
                Reads{' '}
                {selected.reads
                  .map((type) => TYPE_LABELS[type])
                  .join(', ')
                  .toLowerCase()}
              </p>
              {selected.href === undefined ? null : (
                <a
                  className={`button button-3 filled ${styles['apps__link']}`}
                  href={selected.href}
                >
                  Open {selected.title}
                </a>
              )}
            </div>
          </div>
        </div>

        <p className={styles['convergence__footnote']}>
          Gathered under your control, served on modern data standards (FHIR R4).
        </p>
      </div>
    </section>
  )
}

export { Convergence }
