import { Href } from 'expo-router'
import { JSX } from 'react'
import { Text } from 'react-native'

export default function ItemList({
  title,
  items,
  onDelete: handleDelete,
}: {
  title: string
  items: { id: string; title: string; subtitle?: string; destination: Href }[]
  onDelete?: (indices: number[]) => void
}): JSX.Element {
  return <Text>Loaded As Default</Text>
}
