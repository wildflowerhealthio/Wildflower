import { Link } from '@tanstack/react-router'
import type { LinkComponentProps, RegisteredRouter } from '@tanstack/react-router'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { JSX } from 'react'

import { SettingsIcon } from './settings-icon.tsx'
import styles from './settings-link.module.css'

/**
 * Props for {@link SettingsLink}: `href` and `label`, and any other `<Link>`
 * prop (`id`, `data-*`, `ref`, a `className` added to its own), which go to
 * the root `<Link>`. Its `to`, children, `aria-label` and `title` come from
 * `href` and `label`, so a caller cannot set them. `TTo` is `string` so a
 * plain-path `href` type-checks under any registered router.
 */
interface SettingsLinkProps extends Omit<
  LinkComponentProps<'a', RegisteredRouter, string, string>,
  'to' | 'children' | 'aria-label' | 'title'
> {
  /** The settings screen's absolute in-app path (e.g. `/settings`). */
  readonly href: string
  /** What the screen is called, as the link's accessible name and tooltip. */
  readonly label: string
}

/**
 * A gear linking to a settings screen, for a top-level page's
 * `<PageHeader actions>`: a ghost button in the header bar's text colour,
 * labelled for assistive technology and on hover by `label`.
 *
 * The destination is a plain path, like `<PageHeader backHref>`, so a slice
 * whose own route tree lacks the app's settings route can still link to it.
 */
const SettingsLink = ({ href, label, className, ...rootProps }: SettingsLinkProps): JSX.Element => (
  <Link
    {...rootProps}
    to={href}
    className={cn('button button-2 ghost', styles['settings-link'], className)}
    aria-label={label}
    title={label}
  >
    <SettingsIcon />
  </Link>
)

export { SettingsLink }
export type { SettingsLinkProps }
