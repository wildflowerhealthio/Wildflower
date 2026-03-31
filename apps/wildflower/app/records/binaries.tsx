import React from 'react'

import { DateTime } from 'effect'
import { Href } from 'expo-router'
import { binaries$ } from 'fhir-r4-livestore/queries'
import ItemList from '@/components/ui/item-list'
import { useAppStore } from '../../livestore/store'

export default function TabTwoScreen(): React.JSX.Element {
  const store = useAppStore()
  const binaries = store.useQuery(binaries$)

  return (
    <ItemList
      title="Binaries"
      onDelete={() => {}}
      items={binaries.map((binary) => ({
        id: binary.id!,
        title: binary.meta?.source || 'Binary Record',
        destination: `/records/binaries/${binary.id}` satisfies Href,
        subtitle: binary.meta?.lastUpdated
          ? DateTime.formatLocal(binary.meta.lastUpdated)
          : undefined,
      }))}
    />
  )
}
