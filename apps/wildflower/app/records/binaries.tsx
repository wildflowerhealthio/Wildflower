import React from 'react'

import { DateTime } from 'effect'
import { type Href } from 'expo-router'
import ItemList from '@/components/ui/item-list'
import { binaries$ } from '@/livestore/queries'
import { events } from '@/livestore/schema'
import { useAppStore } from '../../livestore/store'

export default function BinaryList(): React.JSX.Element {
  const store = useAppStore()
  const binaries = store.useQuery(binaries$)

  return (
    <ItemList
      title="Binaries"
      onDelete={(indices) => {
        store.commit(...indices.map((i) => events.binaryDeleted({ id: binaries[i].id })))
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
