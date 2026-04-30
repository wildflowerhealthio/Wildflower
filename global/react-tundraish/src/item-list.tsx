import { cn } from 'kitchen-sink'
import type { JSX, ReactNode } from 'react'

type ItemListItem = {
  readonly id: string
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly badge?: ReactNode
  readonly href?: string
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly actions?: ReactNode
}

type ItemListProps = {
  readonly title?: ReactNode
  readonly items: readonly ItemListItem[]
  readonly className?: string
}

const ItemList = ({ title, items, className }: ItemListProps): JSX.Element | null => {
  if (items.length === 0) return null
  return (
    <section className={cn('item-list', className)}>
      {title !== undefined ? <h3 className="text-label-3 item-list__title">{title}</h3> : null}
      <ul className="item-list__rows">
        {items.map((item) => (
          <ItemListRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

const ItemListRow = ({ item }: { item: ItemListItem }): JSX.Element => {
  const badgeJsx =
    item.badge !== undefined ? <span className="item-list__badge">{item.badge}</span> : null
  const subtitleJsx =
    item.subtitle !== undefined ? (
      <span className="item-list__subtitle text-body-3">{item.subtitle}</span>
    ) : null
  const actionsJsx =
    item.actions !== undefined ? <span className="item-list__actions">{item.actions}</span> : null
  const body = (
    <>
      <div className="item-list__text">
        <div className="item-list__title-row">
          <span className="item-list__name text-body-2">{item.title}</span>
          {badgeJsx}
        </div>
        {subtitleJsx}
      </div>
      {actionsJsx}
      <span aria-hidden="true" className="item-list__chevron">
        ›
      </span>
    </>
  )

  const rowClass = cn('item-list__row', { 'item-list__row--disabled': item.disabled === true })

  if (item.href !== undefined) {
    if (item.disabled === true) {
      return (
        <li className={rowClass}>
          <span className="item-list__link" aria-disabled="true">
            {body}
          </span>
        </li>
      )
    }
    return (
      <li className={rowClass}>
        <a className="item-list__link" href={item.href}>
          {body}
        </a>
      </li>
    )
  }

  return (
    <li className={rowClass}>
      <button
        type="button"
        className="item-list__button"
        disabled={item.disabled}
        onClick={() => item.onClick?.()}
      >
        {body}
      </button>
    </li>
  )
}

export { ItemList, type ItemListItem, type ItemListProps }
