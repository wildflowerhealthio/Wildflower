import type { JSX, ReactNode } from 'react'

import { APP_DESCRIPTIONS, anchorHref, fromApp, type AppSectionId } from 'branding-core'

import styles from './app-landing.module.css'

/**
 * The standalone landing content for one SMART app: its `APP_DESCRIPTIONS`
 * introduction (the name as the page's `h1`, the tagline, the paragraphs, and
 * a link to the rest of the homepage; no status line — an app someone has
 * reached is usable) with the action area. See "The app landing page" in
 * `slices/branding/AGENTS.md`.
 *
 * @param app - Which app's description to render.
 * @param children - The action area: the app's connect menu, whose heading is an `h2`.
 *
 * @remarks
 * The DOM order is name and tagline, then the action area, then the "why"
 * paragraphs and link. On one column that is the reading order: a visitor
 * sees what the app is and can connect before the longer story. On two
 * columns the grid moves the action area to the right, beside both text
 * blocks.
 */
function AppLanding({
  app,
  children,
}: {
  readonly app: AppSectionId
  readonly children: ReactNode
}): JSX.Element {
  const { name, tagline, paragraphs, anchor } = APP_DESCRIPTIONS[app]

  return (
    <section className={styles['app-landing']} aria-labelledby="app-landing-title">
      <div className={styles['app-landing__lede']}>
        <h1 id="app-landing-title" className={styles['app-landing__title']}>
          {name}
        </h1>
        <p className={styles['app-landing__tagline']}>{tagline}</p>
      </div>
      <div className={styles['app-landing__action']}>{children}</div>
      <div className={styles['app-landing__story']}>
        {paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <a className={styles['app-landing__more']} href={anchorHref(fromApp, anchor)}>
          Read about the rest of the project on wildflowerhealth.io
        </a>
      </div>
    </section>
  )
}

export { AppLanding }
