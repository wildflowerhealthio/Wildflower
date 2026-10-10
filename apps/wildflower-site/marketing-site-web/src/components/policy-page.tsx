import { SiteFooter, SiteHeader, fromApp } from '@wildflowerhealthio/branding-react'
import type { JSX, ReactNode } from 'react'

import layout from './layout.module.css'
import styles from './policy-page.module.css'

/**
 * The shell of the site's policy pages (`/privacy-policy/`, `/deletion/`): the
 * shared header and footer around one prose column with the page title and
 * the date the text last changed.
 *
 * The pages live one directory below the homepage, so the header takes the
 * `fromApp` context: its links resolve to absolute URLs on the canonical site,
 * the way an app's header does, rather than to fragments of this page.
 */
function PolicyPage({
  title,
  updated,
  children,
}: {
  readonly title: string
  /** When the policy text last changed, as an ISO date (`YYYY-MM-DD`). */
  readonly updated: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <>
      <SiteHeader nav={fromApp} />
      <main className={styles['policy-page']}>
        <div className={layout['column']}>
          <h1 className={styles['policy-page__title']}>{title}</h1>
          <p className={layout['mono-note']}>
            Last updated <time dateTime={updated}>{updated}</time>
          </p>
          <div className={styles['policy-page__body']}>{children}</div>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}

/** One titled part of a policy page: an `h2` and its prose. */
function PolicySection({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <section className={styles['policy-page__section']}>
      <h2 className={layout['block-title']}>{title}</h2>
      {children}
    </section>
  )
}

export { PolicyPage, PolicySection }
