import { Host, Text, ListItem, LazyColumn } from '@expo/ui/jetpack-compose'
import { clickable, fillMaxWidth, paddingAll } from '@expo/ui/jetpack-compose/modifiers'
import { Href, useRouter } from 'expo-router'
import { JSX } from 'react'

export default function ItemList({
  title,
  items,
  onDelete: handleDelete,
}: {
  title: string
  items: { id: string; title: string; subtitle?: string; destination: Href }[]
  onDelete?: (indices: number[]) => void
}): JSX.Element {
  const router = useRouter()
  return (
    <Host style={{ flex: 1 }}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 8 }}
        horizontalAlignment="center"
        modifiers={[fillMaxWidth(), paddingAll(16)]}
      >
        <Text style={{ typography: 'labelLarge', textAlign: 'start' }} modifiers={[fillMaxWidth()]}>
          {title}
        </Text>
        {items.map((item) => (
          <ListItem
            modifiers={[clickable(() => router.push(item.destination))]}
            key={item.id}
            headline={item.title}
          >
            {/* <ListItem.Leading>{item.title}</ListItem.Leading> */}
            {item.subtitle ? (
              <ListItem.SupportingContent>
                <Text>{item.subtitle}</Text>
              </ListItem.SupportingContent>
            ) : null}
          </ListItem>
        ))}
      </LazyColumn>
    </Host>
  )
}
