import type { JSX } from 'react'
import { CheckboxGroup, type CheckboxGroupItem } from 'react-tundraish'
import type { Cell } from 'scopes-core'

/**
 * One selectable control in a {@link PermissionPicker} — a permission item (its id,
 * display name, and mono code) plus its resolved {@link Cell.State} and the pre-rendered
 * lock/disable `reason` copy. The grid model (`buildGrid`) resolves the cell via
 * `Cell.forItem` and renders the reason, so this component stays a pure presenter and the
 * same shape carries a v2 interaction or a v1 Read/Write word.
 */
interface PickerItem {
  readonly id: string
  readonly name: string
  readonly code: string
  readonly state: Cell.State
  /** The rendered lock/disable explanation (localized copy), or `null` when editable. */
  readonly reason: string | null
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

const toItem = ({ id, name, code, state, reason }: PickerItem): CheckboxGroupItem<string> => ({
  id,
  label: name,
  mono: code,
  checked: state === 'on' || state === 'locked',
  locked: state === 'locked',
  disabled: state === 'disabled',
  reason,
})

/**
 * The permission editor — a {@link CheckboxGroup} over a permission style's items,
 * generic over the form. A `locked` item is checked + disabled (required /
 * wildcard-covered), a `disabled` one is outside the scope request. The
 * lock/disable decisions come from `scopes-core` (`Cell.forItem`);
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
