import { useState } from 'react'
import { CheckboxGroup, type CheckboxGroupItem } from 'react-tundraish'

type Interaction = 'c' | 'r' | 'u' | 'd' | 's'

const permissions: readonly CheckboxGroupItem<Interaction>[] = [
  { id: 'r', label: 'Read', mono: 'r', checked: true, locked: true, disabled: false, reason: 'Required by this app' },
  { id: 's', label: 'Search', mono: 's', checked: true, locked: false, disabled: false },
  { id: 'c', label: 'Create', mono: 'c', checked: false, locked: false, disabled: false },
  { id: 'u', label: 'Update', mono: 'u', checked: false, locked: false, disabled: false },
  { id: 'd', label: 'Delete', mono: 'd', checked: false, locked: false, disabled: true, reason: 'Not offered for Observation' },
]

const useToggled = (initial: readonly CheckboxGroupItem<Interaction>[]) => {
  const [items, setItems] = useState(initial)
  const onToggle = (id: Interaction) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item)))
  }
  return { items, onToggle }
}

/**
 * The permission picker (scopes-react) — boxed checkboxes stacked in a column,
 * each with its SMART interaction code. `Read` is locked (checked + disabled,
 * required); `Delete` is inapplicable here (disabled, still shown).
 */
export const Permissions = () => {
  const { items, onToggle } = useToggled(permissions)
  return <CheckboxGroup ariaLabel="Permissions on Observation" items={items} onToggle={onToggle} />
}

/** `direction="row"` — the compact layout for a short set. */
export const Row = () => {
  const { items, onToggle } = useToggled(permissions.slice(0, 4))
  return <CheckboxGroup ariaLabel="Permissions on Patient" direction="row" items={items} onToggle={onToggle} />
}

/**
 * `variant="plain"` — the chrome-less checklist for embedding inside a host
 * card (a permission-statement popover); codes right-aligned.
 */
export const Plain = () => {
  const { items, onToggle } = useToggled(permissions)
  return (
    <div
      style={{
        maxWidth: 280,
        padding: 12,
        border: '1px solid var(--color-divider)',
        borderRadius: 'var(--radius-2)',
      }}
    >
      <CheckboxGroup ariaLabel="Permissions on Observation" variant="plain" items={items} onToggle={onToggle} />
    </div>
  )
}
