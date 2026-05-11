import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './item-list.module.css'

type ItemListItemBase = {
  readonly id: string
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly badge?: ReactNode
  readonly disabled?: boolean
  readonly actions?: ReactNode
}

type ItemListItem = ItemListItemBase &
  (
    | { readonly href: string; readonly onClick?: never }
    | { readonly href?: never; readonly onClick: () => void }
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
  const subtitleJsx =
    item.subtitle !== undefined ? (
      <span className={cn(styles['item-list__subtitle'], 'text-body-3')}>{item.subtitle}</span>
    ) : null
  const actionsJsx =
    item.actions !== undefined ? (
      <span className={styles['item-list__actions']}>{item.actions}</span>
    ) : null
  const body = (
    <>
      <div className={styles['item-list__text']}>
        <div className={styles['item-list__title-row']}>
          <span className={cn(styles['item-list__name'], 'text-body-2')}>{item.title}</span>
          {badgeJsx}
        </div>
        {subtitleJsx}
      </div>
      {actionsJsx}
      <span aria-hidden="true" className={styles['item-list__chevron']}>
        ›
      </span>
    </>
  )

  const rowClass = cn(styles['item-list__row'], {
    [styles['item-list__row--disabled']]: item.disabled === true,
  })

  if (item.href !== undefined) {
    if (item.disabled === true) {
      return (
        <li className={rowClass}>
          <span className={styles['item-list__link']} aria-disabled="true">
            {body}
          </span>
        </li>
      )
    }
    return (
      <li className={rowClass}>
        <a className={styles['item-list__link']} href={item.href}>
          {body}
        </a>
      </li>
    )
  }

  return (
    <li className={rowClass}>
      <button
        type="button"
        className={styles['item-list__button']}
        disabled={item.disabled}
        onClick={() => item.onClick()}
      >
        {body}
      </button>
    </li>
  )
}

export { ItemList, type ItemListItem, type ItemListProps }
