import { Link } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './page-header.module.css'

type PageHeaderProps = {
  /**
   * The page title. Keep it short — the title renders on a single line and
   * truncates with an ellipsis rather than wrapping, so a long title is
   * clipped on narrow (mobile) viewports instead of pushing the header
   * taller.
   */
  readonly title: string
  /**
   * Optional secondary line under the title — a per-record identifier (a
   * URL, a client id) that would overflow a single-line title. Like the
   * title it stays on one line and truncates with an ellipsis, and it is
   * not a heading, so the page keeps exactly one `<h1>`.
   */
  readonly subtitle?: ReactNode
  /**
   * Destination for the back affordance. When set, a leading back link
   * renders that navigates to this absolute path (the page's logical
   * parent). Omit on top-level surfaces (the tab destinations) that have
   * nowhere to go back to.
   */
  readonly backHref?: string
  /** Accessible label for the back link. Defaults to `Back`. */
  readonly backLabel?: string
  /** Optional trailing controls (e.g. a "Manage" button), aligned to the end. */
  readonly actions?: ReactNode
}

/**
 * Single, consistent page header: an optional back link, a single-line
 * title with an optional secondary `subtitle` line, and an optional
 * trailing actions slot. Every screen renders exactly one of these as the
 * first child of its page shell, so a page never stacks two headings.
 *
 * The back link is a TanStack `<Link>` to a fixed parent path (not a
 * history pop), so it behaves predictably on a refreshed or deep-linked
 * page where there is no in-app history to pop. Generic on purpose — it
 * carries no app-specific knowledge, only a title and a parent path.
 */
const PageHeader = ({
  title,
  subtitle,
  backHref,
  backLabel = 'Back',
  actions,
}: PageHeaderProps): JSX.Element => (
  <header className={styles['page-header']}>
    {backHref !== undefined ? (
      <Link to={backHref} className={styles['page-header__back']} aria-label={backLabel}>
        <span aria-hidden="true" className={styles['page-header__back-chevron']}>
          &#x2039;
        </span>
        {backLabel}
      </Link>
    ) : null}
    <div className={styles['page-header__main']}>
      <div className={styles['page-header__heading']}>
        <h1 className={styles['page-header__title']}>{title}</h1>
        {subtitle !== undefined ? (
          <p className={cn(styles['page-header__subtitle'], 'text-body-3')}>{subtitle}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className={styles['page-header__actions']}>{actions}</div>
      ) : null}
    </div>
  </header>
)

export { PageHeader, type PageHeaderProps }
