import {
  Host,
  List,
  Section,
  VStack,
  HStack,
  Spacer,
  Text,
  Rectangle,
  Button,
} from '@expo/ui/swift-ui'
import { foregroundStyle, onTapGesture, shapes } from '@expo/ui/swift-ui/modifiers'
import {
  border,
  buttonStyle,
  contentShape,
  controlSize,
  font,
  listRowBackground,
  listStyle,
  scrollContentBackground,
  tag,
} from '@expo/ui/swift-ui/modifiers'
import { useRouter, type Href } from 'expo-router'
import { type JSX } from 'react'

import ContextMenuWrapper, { type ContextMenuAction } from '@/components/ui/context-menu'

type ItemListItem = { id: string; title: string; destination: Href; subtitle?: string }

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
  const resolvedActions = actions ?? []
  const router = useRouter()
  return (
    <Host style={{ flex: 1 }}>
      <List modifiers={[listStyle('insetGrouped'), scrollContentBackground('hidden')]}>
        <Section title={title}>
          {items.map((item) => (
            <Button
              role="default"
              key={item.id}
              modifiers={[
                buttonStyle('plain'),
                controlSize('regular'),
                contentShape(shapes.rectangle()),
                onTapGesture(() => {
                  router.push(item.destination)
                }),
              ]}
            >
              <HStack
                key={item.id}
                alignment="center"
                modifiers={[tag(item.id), listRowBackground('systemBackground')]}
              >
                <VStack alignment="leading" spacing={2}>
                  <Text modifiers={[font({ size: 17 }), foregroundStyle('label')]}>
                    {item.title}
                  </Text>
                  {item.subtitle ? (
                    <Text modifiers={[font({ size: 14 }), foregroundStyle('secondaryLabel')]}>
                      {item.subtitle}
                    </Text>
                  ) : null}
                </VStack>
                <Spacer />
                <ContextMenuWrapper
                  actions={resolvedActions}
                  onAction={(actionKey) => onAction?.(actionKey, item)}
                />
              </HStack>
            </Button>
          ))}
        </Section>
      </List>
    </Host>
  )
}
