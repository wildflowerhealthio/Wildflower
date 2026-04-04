import React from 'react'

import { DateTime } from 'effect'
import { type Href, useRouter } from 'expo-router'
import ItemList from '@/components/ui/item-list'
import { binaries$ } from '@/livestore/queries'
import { events } from '@/livestore/schema'
import { useAppStore } from '@/livestore/store'

export default function BinaryList(): React.JSX.Element {
  const router = useRouter()
  const store = useAppStore()
  const binaries = store.useQuery(binaries$)

  return (
    <ItemList
      title="Binaries"
      actions={[
        { key: 'open', label: 'Open', systemImage: 'eye' },
        { key: 'delete', label: 'Delete', role: 'destructive', systemImage: 'trash' },
      ]}
      onAction={(actionKey, item) => {
        if (actionKey === 'open') {
          router.push(`/records/binaries/${item.id}` satisfies Href)
        } else if (actionKey === 'delete') {
          const binary = binaries.find((b) => b.id === item.id)
          if (binary) store.commit(events.binaryDeleted({ id: binary.id }))
        }
      }}
      items={binaries.map((binary) => ({
        id: binary.id,
        title: binary.meta?.source || 'Binary Record',
        destination: `/records/binaries/${binary.id}` satisfies Href,
        subtitle: binary.meta?.lastUpdated
          ? DateTime.formatLocal(binary.meta.lastUpdated)
          : undefined,
      }))}
    />
  )
}
