import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import { Link } from '@tanstack/react-router'
import styles from './item-list.module.css'

type ItemListItemBase = {
  readonly id: string
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  /**
   * Optional leading slot — renders before the text column. Use for a
   * status dot, leading icon, or other compact mark. Vertically centered
   * with the title row.
   */
  readonly leading?: ReactNode
  /**
   * Optional right-aligned mark inside the title row (sharing the
   * title's baseline). Use for compact metadata like a relative
   * timestamp; for actionable controls that sit at the row's outer
   * right edge, use `actions` instead.
   */
  readonly meta?: ReactNode
  readonly badge?: ReactNode
  readonly disabled?: boolean
  readonly actions?: ReactNode
  /**
   * Row tone — paints a faint background tint across the whole row.
   * Defaults to `neutral` (no tint). `danger` tints the row with the
   * danger ramp so a single failure entry stands out within an
   * otherwise-quiet list.
   */
  readonly tone?: 'neutral' | 'danger'
}

/**
 * Four interaction variants:
 * - `href` → navigates (TanStack `<Link>` for in-app paths, `<a>` for
 *   absolute URLs).
 * - `onClick` → button.
 * - `formAction` → a real same-origin `<form method="post">` submit (e.g.
 *   logout, which MUST be a POST — a GET would be CSRF-able via a top-level
 *   navigation). The browser posts and follows the handler's redirect.
 * - none → static, non-interactive row (e.g. a read-only feed entry).
 */
type ItemListItem = ItemListItemBase &
  (
    | { readonly href: string; readonly onClick?: never; readonly formAction?: never }
    | { readonly href?: never; readonly onClick: () => void; readonly formAction?: never }
    | {
        readonly href?: never
        readonly onClick?: never
        readonly formAction: string
        readonly method: 'post'
      }
    | { readonly href?: never; readonly onClick?: never; readonly formAction?: never }
  )

type ItemListProps = {
  readonly title?: ReactNode
  readonly items: readonly ItemListItem[]
  readonly className?: string
}

const ItemList = ({ title, items, className }: ItemListProps): JSX.Element | null => {
  if (items.length === 0) return null
  return (
    <section className={cn(styles['item-list'], className)}>
      {title !== undefined ? (
        <h3 className={cn('text-label-3', styles['item-list__title'])}>{title}</h3>
      ) : null}
      <ul className={styles['item-list__rows']}>
        {items.map((item) => (
          <ItemListRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

const ItemListRow = ({ item }: { item: ItemListItem }): JSX.Element => {
  const badgeJsx =
    item.badge !== undefined ? (
      <span className={styles['item-list__badge']}>{item.badge}</span>
    ) : null
  const metaJsx =
    item.meta !== undefined ? <span className={styles['item-list__meta']}>{item.meta}</span> : null
  const subtitleJsx =
    item.subtitle !== undefined ? (
      <span className={cn(styles['item-list__subtitle'], 'text-body-3')}>{item.subtitle}</span>
    ) : null
  const leadingJsx =
    item.leading !== undefined ? (
      <span className={styles['item-list__leading']} aria-hidden="true">
        {item.leading}
      </span>
    ) : null
  const actionsJsx =
    item.actions !== undefined ? (
      <span className={styles['item-list__actions']}>{item.actions}</span>
    ) : null
  const textChildren = (
    <>
      <span className={styles['item-list__title-row']}>
        <span className={cn(styles['item-list__name'], 'text-body-2')}>{item.title}</span>
        {badgeJsx}
        {metaJsx}
      </span>
      {subtitleJsx}
    </>
  )

  const rowClass = cn(
    styles['item-list__row'],
    item.disabled === true ? styles['item-list__row--disabled'] : null,
    item.tone === 'danger' ? styles['item-list__row--tone-danger'] : null
  )
  const textClass = styles['item-list__text']

  const textElement = ((): JSX.Element => {
    if (item.href !== undefined) {
      if (item.disabled === true) {
        return (
          <span className={textClass} aria-disabled="true">
            {textChildren}
          </span>
        )
      }
      if (item.href.startsWith('/')) {
        return (
          <Link className={textClass} to={item.href}>
            {textChildren}
          </Link>
        )
      }
      return (
        <a className={textClass} href={item.href}>
          {textChildren}
        </a>
      )
    }
    if (item.formAction !== undefined) {
      // A real same-origin form POST (e.g. logout). `display: contents` on the
      // form lets the submit button fill the row exactly like an `onClick`
      // button; the browser performs the POST and follows the handler's 303.
      return (
        <form method={item.method} action={item.formAction} className={styles['item-list__form']}>
          <button type="submit" className={textClass} disabled={item.disabled}>
            {textChildren}
          </button>
        </form>
      )
    }
    if (item.onClick !== undefined) {
      return (
        <button
          type="button"
          className={textClass}
          disabled={item.disabled}
          onClick={() => item.onClick()}
        >
          {textChildren}
        </button>
      )
    }
    // Static row — no href, no onClick. Plain wrapper, no button/link
    // semantics; the row reads as an entry rather than a control.
    return <span className={textClass}>{textChildren}</span>
  })()

  return (
    <li className={rowClass}>
      {leadingJsx}
      {textElement}
      {actionsJsx}
    </li>
  )
}

export { ItemList, type ItemListItem, type ItemListProps }
