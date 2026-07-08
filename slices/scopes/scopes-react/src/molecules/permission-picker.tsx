import type { JSX } from 'react'
import { CheckboxGroup, type CheckboxGroupItem } from 'react-tundraish'
import type { Cell } from 'scopes-core'

/**
 * One selectable control in a {@link PermissionPicker} — a permission item (its id,
 * display name, and mono code) plus its resolved {@link Cell.State} and the pre-rendered
 * lock/disable `reason` copy. Generic over the style's interaction key `TInteractions`
 * (`'c'|…|'s'` for cruds, `'read'|'write'` for the v1 words) so the id it hands back to
 * {@link PermissionPickerProps.onToggle} stays the variant's own literal.
 * `pickerItemsFor` (`picker-items.ts`) resolves the cell (via the row's `cellFor`) and
 * renders the reason, so this component stays a pure presenter and the same shape
 * carries a v2 interaction or a v1 Read/Write word.
 */
interface PickerItem<TInteractions extends string> {
  readonly id: TInteractions
  readonly name: string
  readonly code: string
  readonly state: Cell.State
  /** The rendered lock/disable explanation (localized copy), or `null` when editable. */
  readonly reason: string | null
}

interface PermissionPickerProps<TInteractions extends string> {
  /** The controls to offer, in display order. */
  readonly items: readonly PickerItem<TInteractions>[]
  readonly onToggle: (id: TInteractions) => void
  /** Accessible name for the group (e.g. "Permissions on Observation"). */
  readonly ariaLabel?: string
  readonly direction?: 'column' | 'row'
  readonly variant?: 'boxed' | 'plain'
  readonly className?: string
}

const toItem = <TInteractions extends string>({
  id,
  name,
  code,
  state,
  reason,
}: PickerItem<TInteractions>): CheckboxGroupItem<TInteractions> => ({
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
const PermissionPicker = <TInteractions extends string>({
  items,
  onToggle,
  ariaLabel,
  direction,
  variant,
  className,
}: PermissionPickerProps<TInteractions>): JSX.Element => (
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
