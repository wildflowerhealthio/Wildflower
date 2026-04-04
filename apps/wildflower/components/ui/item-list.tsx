import { Link, type Href } from 'expo-router'
import { type JSX } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import ContextMenuWrapper, { type ContextMenuAction } from '@/components/ui/context-menu'
import { useThemeColor } from '@/hooks/use-theme-color'

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
  const iconColor = useThemeColor({}, 'icon')
  const tintColor = useThemeColor({}, 'tint')
  const resolvedActions = actions ?? []

  return (
    <View style={styles.container}>
      <Text style={[styles.sectionTitle, { color: iconColor }]}>{title}</Text>
      {items.map((item, index) => (
        <ContextMenuWrapper
          key={item.id}
          actions={resolvedActions}
          onAction={(actionKey) => onAction?.(actionKey, item)}
        >
          <Link href={item.destination} asChild>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                index < items.length - 1 && styles.rowBorder,
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowTitle, { color: tintColor }]}>{item.title}</Text>
                {item.subtitle ? (
                  <Text style={[styles.rowSubtitle, { color: iconColor }]}>{item.subtitle}</Text>
                ) : null}
              </View>
              <Text style={[styles.chevron, { color: iconColor }]}>›</Text>
            </Pressable>
          </Link>
        </ContextMenuWrapper>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  rowContent: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
  },
  rowSubtitle: {
    fontSize: 13,
  },
  chevron: {
    fontSize: 20,
    marginLeft: 8,
  },
})
