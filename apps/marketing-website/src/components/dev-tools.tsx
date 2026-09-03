import type { JSX } from 'react'

import { sectionRootPath } from 'branding-core'

import { Launcher } from './launcher.tsx'
import styles from './dev-tools.module.css'
import layout from './layout.module.css'

/**
 * "Some extra tooling for developers" — the Web Trace Viewer. Sits after the
 * policy asks on purpose, so the argument lands before the dev tooling.
 */
function DevTools(): JSX.Element {
  return (
    <section className={layout['section']} id="developers">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>Some extra tooling for developers</h2>
        <div className={styles['dev-tools']}>
          <h3 className={styles['dev-tools__title']}>Web Trace Viewer</h3>
          <p className={styles['dev-tools__body']}>
            The Importer is built so that writing a module for a new site is easy. This app stores
            the traces you capture as records on your FHIR server, where you can view and edit them.
            If you can scrub your data on device, it's easy enough to share the data shape with a
            developer or coding LLM.&nbsp;It replaces all your identifiers and data, with request
            and response shapes intact.
          </p>
          <div className={styles['dev-tools__launcher']}>
            <Launcher
              href={sectionRootPath('webTrace')}
              label="Open the Web Trace Viewer"
              note="Load a capture against the demo server — no account, nothing uploaded"
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export { DevTools }
