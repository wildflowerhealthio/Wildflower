import { Host, Text, ListItem, LazyColumn, Card } from '@expo/ui/jetpack-compose'
import { background, clickable, fillMaxWidth, paddingAll } from '@expo/ui/jetpack-compose/modifiers'
import { type Href, useRouter } from 'expo-router'
import { type JSX } from 'react'

import ContextMenuWrapper, { type ContextMenuAction } from '@/components/ui/context-menu'

type ItemListItem = { id: string; title: string; subtitle?: string; destination: Href }

export default function ItemList({
  title,
  items,
  actions,
  onAction,
}: {
  title: string
  items: ItemListItem[]
  actions?: ContextMenuAction[]
  onAction?: (actionKey: string, item: ItemListItem) => void
}): JSX.Element {
  const router = useRouter()
  const resolvedActions = actions ?? []

  return (
    <Host style={{ flex: 1 }}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 2 }}
        horizontalAlignment="center"
        modifiers={[fillMaxWidth(), paddingAll(16)]}
      >
        <Text
          style={{ typography: 'labelLarge', textAlign: 'start' }}
          color="#49454F"
          modifiers={[fillMaxWidth()]}
        >
          {title}
        </Text>
        <Card elevation={0} modifiers={[fillMaxWidth()]}>
          {items.map((item) => (
            <ListItem
              key={item.id}
              modifiers={[clickable(() => router.push(item.destination))]}
              headline={item.title}
              supportingText={item.subtitle}
            >
              {resolvedActions.length > 0 ? (
                <ListItem.Trailing>
                  <ContextMenuWrapper
                    actions={resolvedActions}
                    onAction={(actionKey) => onAction?.(actionKey, item)}
                  />
                </ListItem.Trailing>
              ) : null}
            </ListItem>
          ))}
        </Card>
      </LazyColumn>
    </Host>
  )
}
