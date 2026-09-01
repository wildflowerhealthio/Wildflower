import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { cn, usePreviousDistinctValue } from 'react-kitchen-sink'

import styles from './menu.module.css'

type MenuItemBase = {
  readonly id: string
  readonly label: ReactNode
  readonly destructive?: boolean
}

type MenuItem = MenuItemBase &
  (
    | { readonly disabled: true; readonly onSelect?: () => void }
    | { readonly disabled?: false; readonly onSelect: () => void }
  )

type MenuProps = {
  readonly items: readonly MenuItem[]
  readonly label?: string
  readonly align?: 'start' | 'end'
  readonly className?: string
}

const findFirstEnabled = (items: readonly MenuItem[]): number => {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item !== undefined && item.disabled !== true) return i
  }
  return -1
}

const findLastEnabled = (items: readonly MenuItem[]): number => {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item !== undefined && item.disabled !== true) return i
  }
  return -1
}

const Menu = ({
  items,
  label = 'More actions',
  align = 'end',
  className,
}: MenuProps): JSX.Element => {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  const firstEnabledIndex = findFirstEnabled(items)
  const lastEnabledIndex = findLastEnabled(items)

  // Reset the highlighted index when the menu opens (or when the first
  // enabled item shifts while open). Adjust state during render — a
  // useEffect version cascades a render and paints the stale index for
  // one frame. `usePreviousDistinctValue` (react-kitchen-sink) hands back
  // the value from the last render in which it differed.
  const prevOpen = usePreviousDistinctValue(open)
  const prevFirstEnabledIndex = usePreviousDistinctValue(firstEnabledIndex)
  if (open && (open !== prevOpen || firstEnabledIndex !== prevFirstEnabledIndex)) {
    setActiveIndex(firstEnabledIndex)
  }

  // Focus follows the highlight — a genuine DOM side effect that has to
  // live in a useEffect, but it no longer also carries a setState.
  useEffect(() => {
    if (open && firstEnabledIndex >= 0) {
      itemRefs.current[firstEnabledIndex]?.focus()
    }
  }, [open, firstEnabledIndex])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current
      const target = event.target
      // node.contains() only sees the rendered subtree. If a future menu item
      // renders content via createPortal (tooltip, submenu, popover), those
      // clicks will land outside rootRef and close the menu mid-interaction.
      if (node !== null && target instanceof Node && !node.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const closeAndRestoreFocus = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const moveActive = (direction: 1 | -1): void => {
    if (items.length === 0) return
    let next = activeIndex
    for (let i = 0; i < items.length; i++) {
      next = (next + direction + items.length) % items.length
      const candidate = items[next]
      if (candidate !== undefined && candidate.disabled !== true) {
        setActiveIndex(next)
        itemRefs.current[next]?.focus()
        return
      }
    }
  }

  const focusIndex = (index: number): void => {
    if (index < 0) return
    setActiveIndex(index)
    itemRefs.current[index]?.focus()
  }

  return (
    <div ref={rootRef} className={cn(styles['menu'], styles[`menu--align-${align}`], className)}>
      <button
        ref={triggerRef}
        type="button"
        className={styles['menu__trigger']}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span aria-hidden="true" className={styles['menu__dots']}>
          …
        </span>
      </button>
      {open ? (
        <ul
          id={menuId}
          className={styles['menu__list']}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            switch (event.key) {
              case 'Escape':
                event.preventDefault()
                closeAndRestoreFocus()
                break
              case 'Tab':
                setOpen(false)
                break
              case 'ArrowDown':
                event.preventDefault()
                moveActive(1)
                break
              case 'ArrowUp':
                event.preventDefault()
                moveActive(-1)
                break
              case 'Home':
                event.preventDefault()
                focusIndex(firstEnabledIndex)
                break
              case 'End':
                event.preventDefault()
                focusIndex(lastEnabledIndex)
                break
            }
          }}
        >
          {items.map((item, index) => (
            <li key={item.id} role="none" className={styles['menu__item-wrapper']}>
              <button
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                type="button"
                role="menuitem"
                tabIndex={index === activeIndex && item.disabled !== true ? 0 : -1}
                className={cn(styles['menu__item'], {
                  [styles['menu__item--destructive']]: item.destructive === true,
                })}
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled !== true) {
                    item.onSelect()
                    closeAndRestoreFocus()
                  }
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export { Menu, type MenuItem, type MenuProps }
