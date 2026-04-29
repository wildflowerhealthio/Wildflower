import type MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { SymbolViewProps } from 'expo-symbols'
import type { ComponentProps } from 'react'

// `SymbolViewProps['name']` is the union `SFSymbol | { ios?, android?, web? }` —
// keep only the string side so the Record key constraint stays satisfied.
type SfSymbolName = Extract<SymbolViewProps['name'], string>
type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

/**
 * SF Symbols → Material Icons mapping shared by every `IconSymbol` platform variant.
 *
 * The `as const satisfies Partial<Record<SfSymbolName, MaterialIconName>>` shape
 * pins both sides at compile time:
 * - keys must be valid SF Symbol names (so the iOS variant is always usable)
 * - values must be valid Material Icon names (so the Android/web fallback resolves)
 *
 * Add new entries here, not inside the platform variants.
 */
const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'folder.fill': 'folder',
  pencil: 'edit',
  trash: 'delete',
  eye: 'visibility',
  'arrow.down.circle': 'file-download',
  'checkmark.circle': 'check-circle',
  'xmark.circle': 'cancel',
  ellipsis: 'more-horiz',
} as const satisfies Partial<Record<SfSymbolName, MaterialIconName>>

type IconSymbolName = keyof typeof MAPPING

export { MAPPING, type IconSymbolName }
