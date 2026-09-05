import type { JSX } from 'react'

import { APP_DESCRIPTIONS, onMarketingSite, sectionHref } from 'branding-core'

import { Launcher } from './launcher.tsx'
import styles from './dev-tools.module.css'
import layout from './layout.module.css'

/**
 * "Some extra tooling for developers" — the Web Trace Viewer, from its
 * shared `APP_DESCRIPTIONS` entry. Sits after the policy asks on purpose, so
 * the argument lands before the dev tooling.
 */
function DevTools(): JSX.Element {
  const webTrace = APP_DESCRIPTIONS.webTrace

  return (
    <section className={layout['section']} id="developers">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>Some extra tooling for developers</h2>
        <div className={styles['dev-tools']}>
          <h3 className={layout['block-title']}>{webTrace.name}</h3>
          {webTrace.paragraphs.map((paragraph) => (
            <p key={paragraph} className={styles['dev-tools__body']}>
              {paragraph}
            </p>
          ))}
          <div className={styles['dev-tools__launcher']}>
            <Launcher
              href={sectionHref(onMarketingSite, 'webTrace')}
              label={webTrace.launch.label}
              note={webTrace.launch.note}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export { DevTools }
