import type { JSX, ReactNode } from 'react'

import { fromApp, type AppSectionId } from 'branding-core'

import { AppLanding } from './app-landing.tsx'
import { SiteFooter } from './site-footer.tsx'
import { SiteHeader } from './site-header.tsx'

import styles from './app-landing-page.module.css'

/**
 * The whole page an app shows when visited without a launch: `SiteHeader`
 * (links resolved `fromApp`), then `AppLanding` inside the `main` landmark,
 * then `SiteFooter`, in a full-height column so the footer sits at the bottom
 * of the viewport even when the landing is shorter than the screen. See "The
 * app landing page" in `slices/branding/AGENTS.md`.
 *
 * @param app - Which app's description `AppLanding` renders.
 * @param children - The action area `AppLanding` places beside the
 *   introduction: the app's connect menu.
 */
function AppLandingPage({
  app,
  children,
}: {
  readonly app: AppSectionId
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className={styles['app-landing-page']}>
      <SiteHeader nav={fromApp} />
      <main className={styles['app-landing-page__main']}>
        <AppLanding app={app}>{children}</AppLanding>
      </main>
      <SiteFooter />
    </div>
  )
}

export { AppLandingPage }
