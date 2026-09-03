import type { JSX, ReactNode } from 'react'

import { APP_DESCRIPTIONS, anchorHref, fromApp, type AppSectionId } from 'branding-core'

import styles from './app-landing.module.css'

/**
 * The standalone landing content for one SMART app: its `APP_DESCRIPTIONS`
 * introduction (the name as the page's `h1`) beside the action area. See
 * "The app landing page" in `slices/branding/AGENTS.md`.
 *
 * @param app - Which app's description to render.
 * @param children - The action area: the app's connect menu, whose heading is an `h2`.
 */
function AppLanding({
  app,
  children,
}: {
  readonly app: AppSectionId
  readonly children: ReactNode
}): JSX.Element {
  const { name, tagline, status, paragraphs, anchor } = APP_DESCRIPTIONS[app]

  return (
    <div className={styles['app-landing']}>
      <section className={styles['app-landing__intro']} aria-labelledby="app-landing-title">
        <h1 id="app-landing-title" className={styles['app-landing__title']}>
          {name}
        </h1>
        <p className={styles['app-landing__tagline']}>{tagline}</p>
        {status === undefined ? null : (
          <span className={styles['app-landing__mono-note']}>{status}</span>
        )}
        <div className={styles['app-landing__prose']}>
          {paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <a className={styles['app-landing__more']} href={anchorHref(fromApp, anchor)}>
          Read the whole story on wildflowerhealth.io &rarr;
        </a>
      </section>
      <div className={styles['app-landing__action']}>{children}</div>
    </div>
  )
}

export { AppLanding }
