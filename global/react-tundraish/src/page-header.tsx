import { Link } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import styles from './page-header.module.css'

type PageHeaderProps = {
  /**
   * The page title. Usually a plain string; accepts `ReactNode` so a
   * small inline mark (e.g. an "Advanced" chip) can sit beside the
   * title text within the `<h1>`. Keep it short — the title renders on
   * a single line and truncates with an ellipsis rather than wrapping,
   * so a long title is clipped on narrow (mobile) viewports instead of
   * pushing the header taller.
   */
  readonly title: ReactNode
  /**
   * Optional secondary line under the app bar — a per-record identifier (a
   * URL, a client id) that would overflow a single-line title. Like the
   * title it stays on one line and truncates with an ellipsis, and it is
   * not a heading, so the page keeps exactly one `<h1>`. Rendered in mono
   * because it is a machine string.
   */
  readonly subtitle?: ReactNode
  /**
   * Destination for the back affordance. When set, a leading back arrow
   * renders that navigates to this absolute path (the page's logical
   * parent). Omit on top-level surfaces (the tab destinations) that have
   * nowhere to go back to.
   */
  readonly backHref?: string
  /** Accessible label for the back arrow. Defaults to `Back`. */
  readonly backLabel?: string
  /** Optional trailing control (e.g. an overflow menu), aligned to the end. */
  readonly actions?: ReactNode
}

/**
 * Back-arrow glyph (Material `arrow_back`). Painted in the foreground colour
 * (not the accent) and `aria-hidden` — the enclosing `<Link>` carries the
 * accessible label.
 */
const BackArrowIcon = (): JSX.Element => (
  <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
  </svg>
)

/**
 * Single, consistent page header, rendered as a top **app bar**: a leading
 * back arrow, an optically-centered single-line title, and an optional
 * trailing action — laid out on a `1fr auto 1fr` grid so the title stays
 * centered regardless of the left/right content widths. An optional
 * `subtitle` line (a machine string) sits beneath the bar. Every screen
 * renders exactly one of these as the first child of its page shell, so a
 * page never stacks two headings. There is no bottom divider — the bar sits
 * directly under the status bar.
 *
 * The back affordance is a TanStack `<Link>` to a fixed parent path (not a
 * history pop), so it behaves predictably on a refreshed or deep-linked page
 * where there is no in-app history to pop. Generic on purpose — it carries no
 * app-specific knowledge, only a title and a parent path.
 */
const PageHeader = ({
  title,
  subtitle,
  backHref,
  backLabel = 'Back',
  actions,
}: PageHeaderProps): JSX.Element => (
  <header className={styles['page-header']}>
    <div className={styles['page-header__bar']}>
      <div className={styles['page-header__lead']}>
        {backHref !== undefined ? (
          <Link to={backHref} className={styles['page-header__back']} aria-label={backLabel}>
            <BackArrowIcon />
          </Link>
        ) : null}
      </div>
      <h1 className={styles['page-header__title']}>{title}</h1>
      <div className={styles['page-header__actions']}>{actions}</div>
    </div>
    {subtitle !== undefined ? <p className={styles['page-header__subtitle']}>{subtitle}</p> : null}
  </header>
)

export { PageHeader, type PageHeaderProps }
