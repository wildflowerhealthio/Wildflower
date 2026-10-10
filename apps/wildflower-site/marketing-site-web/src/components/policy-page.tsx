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
      <h2 className={styles['policy-page__section-title']}>{title}</h2>
      {children}
    </section>
  )
}

/** One kind of data a policy page describes, by the same four facts. */
type PolicyDataKind = {
  /** What the data is. */
  readonly title: string
  /** Where it is kept. */
  readonly where: ReactNode
  /** When it is collected or kept at all. */
  readonly when: ReactNode
  /** How long it is kept. */
  readonly keptFor: ReactNode
  /** How to delete it. */
  readonly delete: ReactNode
}

/**
 * One kind of data as a titled card (an `h4`, under its app's group) of four facts — where, when, how long and
 * how to delete — so every kind reads the same way and the page can be scanned
 * rather than read through. A description list rather than a table, so it
 * stacks at phone width.
 */
function PolicyDataCard({
  title,
  where,
  when,
  keptFor,
  delete: deleteIt,
}: PolicyDataKind): JSX.Element {
  return (
    <div className={styles['policy-page__card']}>
      <h4 className={styles['policy-page__card-title']}>{title}</h4>
      <dl className={styles['policy-page__facts']}>
        <dt>Where</dt>
        <dd>{where}</dd>
        <dt>When</dt>
        <dd>{when}</dd>
        <dt>Kept for</dt>
        <dd>{keptFor}</dd>
        <dt>To delete</dt>
        <dd>{deleteIt}</dd>
      </dl>
    </div>
  )
}

/**
 * The data cards for one kind of app, under an `h3` naming it, so a reader can
 * go straight to the app they use.
 */
function PolicyDataGroup({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className={styles['policy-page__group']}>
      <h3 className={styles['policy-page__group-title']}>{title}</h3>
      {children}
    </div>
  )
}

export { PolicyDataCard, PolicyDataGroup, PolicyPage, PolicySection, type PolicyDataKind }
