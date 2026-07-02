import type { JSX } from 'react'
import { CheckboxGroup, type CheckboxGroupItem } from 'react-tundraish'
import type { Cell } from 'scopes-core'

/**
 * One selectable control in a {@link PermissionPicker} — a permission-style item
 * (its id, display name, and mono code) plus its resolved {@link Cell.Cell} state.
 * Built in `scopes-core` (`configuration.emptyPermission.items` + `Cell.forItem`), so
 * the same shape carries a v2 interaction or a v1 Read/Write word.
 */
interface PickerItem {
  readonly id: string
  readonly name: string
  readonly code: string
  readonly cell: Cell.Cell
}

interface PermissionPickerProps {
  /** The controls to offer, in display order. */
  readonly items: readonly PickerItem[]
  readonly onToggle: (id: string) => void
  /** Accessible name for the group (e.g. "Permissions on Observation"). */
  readonly ariaLabel?: string
  readonly direction?: 'column' | 'row'
  readonly variant?: 'boxed' | 'plain'
  readonly className?: string
}

const toItem = ({ id, name, code, cell }: PickerItem): CheckboxGroupItem<string> => ({
  id,
  label: name,
  code,
  checked: cell.state === 'on' || cell.state === 'locked',
  locked: cell.state === 'locked',
  disabled: cell.state === 'disabled',
  reason: cell.lockReason,
})

/**
 * The permission editor — a {@link CheckboxGroup} over a permission style's items,
 * generic over the form. A `locked` item is checked + disabled (required /
 * wildcard-covered), a `disabled` one is outside the scope request. The
 * lock/disable decisions come from `scopes-core` (`ScopeRequest.buildItemCell`);
 * this component only renders them. It replaces the former v2-only
 * `InteractionPicker` and v1-only `ReadWritePermissionPicker`, which differed
 * only by their item set — now supplied as data.
 */
const PermissionPicker = ({
  items,
  onToggle,
  ariaLabel,
  direction,
  variant,
  className,
}: PermissionPickerProps): JSX.Element => (
  <CheckboxGroup
    items={items.map(toItem)}
    onToggle={(id) => {
      onToggle(id)
    }}
    ariaLabel={ariaLabel}
    direction={direction}
    variant={variant}
    className={className}
  />
)

export { PermissionPicker, type PermissionPickerProps, type PickerItem }
