import { useEffect, useRef } from 'react'
import { Menu, type MenuItem } from 'react-tundraish'

const actions: readonly MenuItem[] = [
  { id: 'edit', label: 'Edit', onSelect: () => {} },
  { id: 'duplicate', label: 'Duplicate', onSelect: () => {} },
  { id: 'archive', label: 'Archive', disabled: true },
  { id: 'revoke', label: 'Revoke access', destructive: true, onSelect: () => {} },
]

/**
 * The opened menu — a meatball (…) trigger with its dropdown list. The list only
 * mounts when open, so this cell clicks the trigger on mount to show the
 * actual menu surface (the state a static preview would otherwise miss).
 */
export const Opened = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.click()
  }, [])
  return (
    <div ref={ref} style={{ minHeight: 220, paddingBottom: 160 }}>
      <Menu label="Actions for this item" align="start" items={actions} />
    </div>
  )
}

/** The resting state: just the kebab trigger button, as it sits in a toolbar. */
export const Trigger = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '8px 12px',
      border: '1px solid var(--color-neutral-8)',
      borderRadius: 'var(--radius-2)',
      maxWidth: 320,
    }}
  >
    <span className="text-body-2">production-api-key</span>
    <Menu label="Actions for production-api-key" items={actions} />
  </div>
)
