import { Button, Menu, type ButtonProps } from '@expo/ui/swift-ui'
import { type JSX } from 'react'

export type ContextMenuAction = {
  key: string
  label: string
  systemImage?: ButtonProps['systemImage']
  role?: 'default' | 'destructive'
}

/**
 * On iOS, renders a native SwiftUI `Menu` with an ellipsis.circle SF Symbol trigger.
 * Tapping the trigger opens the actions menu. Place this alongside row content.
 */
export default function ContextMenuWrapper({
  actions,
  onAction,
}: {
  actions: ContextMenuAction[]
  onAction: (actionKey: string) => void
  children?: React.ReactNode
}): JSX.Element | null {
  if (actions.length === 0) {
    return null
  }

  return (
    <Menu label="" systemImage="ellipsis.circle">
      {actions.map((action) => (
        <Button
          key={action.key}
          role={action.role === 'destructive' ? 'destructive' : undefined}
          systemImage={action.systemImage}
          label={action.label}
          onPress={() => onAction(action.key)}
        />
      ))}
    </Menu>
  )
}
