import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

type MenuItem = {
  readonly id: string
  readonly label: ReactNode
  readonly onSelect: () => void
  readonly disabled?: boolean
  readonly destructive?: boolean
}

type MenuProps = {
  readonly items: readonly MenuItem[]
  readonly label?: string
  readonly align?: 'start' | 'end'
  readonly className?: string
}

const Menu = ({
  items,
  label = 'More actions',
  align = 'end',
  className,
}: MenuProps): JSX.Element => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current
      const target = event.target
      if (node !== null && target instanceof Node && !node.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const classes = ['menu', `menu--align-${align}`, className]
    .filter((c): c is string => c !== undefined)
    .join(' ')

  return (
    <div ref={rootRef} className={classes}>
      <button
        type="button"
        className="menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <span aria-hidden="true" className="menu__dots">
          ⋮
        </span>
      </button>
      {open ? (
        <ul className="menu__list" role="menu">
          {items.map((item) => {
            const itemClass = [
              'menu__item',
              item.destructive === true ? 'menu__item--destructive' : null,
            ]
              .filter((c): c is string => c !== null)
              .join(' ')
            return (
              <li key={item.id} role="none" className="menu__item-wrapper">
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  disabled={item.disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    event.preventDefault()
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export { Menu, type MenuItem, type MenuProps }
