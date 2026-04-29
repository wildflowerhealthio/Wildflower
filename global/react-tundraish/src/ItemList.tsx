import type { JSX, MouseEvent, ReactNode } from 'react'

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

  const classes = ['item-list', className].filter((c) => c !== undefined).join(' ')

  return (
    <section className={classes}>
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
  const body = (
    <>
      <div className="item-list__text">
        <div className="item-list__title-row">
          <span className="item-list__name text-body-2">{item.title}</span>
          {item.badge !== undefined ? <span className="item-list__badge">{item.badge}</span> : null}
        </div>
        {item.subtitle !== undefined ? (
          <span className="item-list__subtitle text-body-3">{item.subtitle}</span>
        ) : null}
      </div>
      {item.actions !== undefined ? (
        <span className="item-list__actions">{item.actions}</span>
      ) : null}
      <span aria-hidden="true" className="item-list__chevron">
        ›
      </span>
    </>
  )

  const rowClass = ['item-list__row', item.disabled === true ? 'item-list__row--disabled' : null]
    .filter((c): c is string => c !== null)
    .join(' ')

  if (item.href !== undefined) {
    return (
      <li className={rowClass}>
        <a className="item-list__link" href={item.href} aria-disabled={item.disabled}>
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
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.preventDefault()
          item.onClick?.()
        }}
      >
        {body}
      </button>
    </li>
  )
}

export { ItemList, type ItemListItem, type ItemListProps }
