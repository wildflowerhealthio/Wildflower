import type { JSX } from 'react'

import { APP_DESCRIPTIONS, onMarketingSite, sectionHref } from 'branding-core'

import { Launcher } from './launcher.tsx'
import styles from './dev-tools.module.css'
import layout from './layout.module.css'

/**
 * "Some extra tooling for developers" — the Synthetic Data Loader, from its
 * shared `APP_DESCRIPTIONS` entry. Sits after the policy asks on purpose, so
 * the argument lands before the dev tooling.
 */
function DevTools(): JSX.Element {
  const syntheticData = APP_DESCRIPTIONS.syntheticData

  return (
    <section className={layout['section']} id="developers">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>Some extra tooling for developers</h2>
        <div className={styles['dev-tools']}>
          <h3 className={layout['block-title']}>{syntheticData.name}</h3>
          {syntheticData.paragraphs.map((paragraph) => (
            <p key={paragraph} className={styles['dev-tools__body']}>
              {paragraph}
            </p>
          ))}
          <div className={styles['dev-tools__launcher']}>
            <Launcher
              href={sectionHref(onMarketingSite, 'syntheticData')}
              label={syntheticData.launch.label}
              note={syntheticData.launch.note}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export { DevTools }
