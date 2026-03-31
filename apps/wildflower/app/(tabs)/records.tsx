import { type Href } from 'expo-router'
import React from 'react'

import ItemList from '@/components/ui/item-list'

export default function RecordsMenu(): React.JSX.Element {
  return (
    <ItemList
      title="All Records"
      items={[
        { title: 'Raw Data', id: 'binaries', destination: '/records/binaries' satisfies Href },
        { title: 'Patients', id: 'patients', destination: '/records/patients' satisfies Href },
      ]}
    />
  )
}
