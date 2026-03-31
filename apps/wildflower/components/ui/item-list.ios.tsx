import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers'
import { Host, List, Label, Section, VStack, Text, Button } from '@expo/ui/swift-ui'
import { environment, buttonStyle, listStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { Link, Href } from 'expo-router'
import { JSX, useState } from 'react'

export default function ItemList({
  title,
  items,
  onDelete: handleDelete,
}: {
  title: string
  items: { id: string; title: string; destination: Href; subtitle?: string }[]
  onDelete?: (indices: number[]) => void
}): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  return (
    <Host style={{ flex: 1 }}>
      <List
        selection={selectedIds}
        onSelectionChange={(ids) => setSelectedIds(ids.map(String))}
        modifiers={[environment('editMode', 'inactive'), listStyle('automatic')]}
      >
        <Section title={title}>
          <List.ForEach onDelete={handleDelete}>
            {items.map((item) => (
              <Link href={item.destination} key={item.id} asChild>
                <Button modifiers={[buttonStyle('plain')]}>
                  <VStack spacing={4} modifiers={[tag(item.id)]}>
                    <Label title={item.title} />
                    {item.subtitle ? (
                      <Text modifiers={[fillMaxWidth()]}>{item.subtitle}</Text>
                    ) : null}
                  </VStack>
                </Button>
              </Link>
            ))}
          </List.ForEach>
        </Section>
      </List>
    </Host>
  )
}
