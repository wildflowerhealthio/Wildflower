import { DropdownMenu, DropdownMenuItem, Icon, IconButton, Text } from '@expo/ui/jetpack-compose'
import { type JSX, useState } from 'react'
import moreVertIcon from '@/assets/icons/more_vert.xml'

export type ContextMenuAction = {
  key: string
  label: string
  systemImage?: string
  role?: 'default' | 'destructive'
}

/**
 * On Android, renders a Material Design 3 IconButton with a DropdownMenu.
 * Place this in a ListItem.Trailing slot or alongside row content.
 */
export default function ContextMenuWrapper({
  actions,
  onAction,
}: {
  actions: ContextMenuAction[]
  onAction: (actionKey: string) => void
  children?: React.ReactNode
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  if (actions.length === 0) {
    return null
  }

  return (
    <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
      <DropdownMenu.Trigger>
        <IconButton onClick={() => setExpanded(true)}>
          <Icon source={moreVertIcon} size={24} contentDescription="More options" />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            onClick={() => {
              setExpanded(false)
              onAction(action.key)
            }}
          >
            <DropdownMenuItem.Text>
              <Text color={action.role === 'destructive' ? '#B3261E' : undefined}>
                {action.label}
              </Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  )
}
