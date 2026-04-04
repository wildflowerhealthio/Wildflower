import { type Href, useRouter } from 'expo-router'

import React from 'react'

import { DateTime } from 'effect'
import ItemList from '@/components/ui/item-list'
import { patients$ } from '@/livestore/queries'
import { events } from '@/livestore/schema'
import { useAppStore } from '@/livestore/store'

export default function PatientsList(): React.JSX.Element {
  const router = useRouter()
  const store = useAppStore()
  const patients = store.useQuery(patients$)

  return (
    <ItemList
      title="Patient Records"
      actions={[
        { key: 'open', label: 'Open', systemImage: 'eye' },
        { key: 'delete', label: 'Delete', role: 'destructive', systemImage: 'trash' },
      ]}
      onAction={(actionKey, item) => {
        if (actionKey === 'open') {
          router.push(`/records/patients/${item.id}` satisfies Href)
        } else if (actionKey === 'delete') {
          const patient = patients.find((p) => p.id === item.id)
          if (patient) store.commit(events.patientDeleted({ id: patient.id }))
        }
      }}
      items={patients.map((patient) => ({
        id: patient.id,
        title: patient.meta?.source || 'Patient Record',
        destination: `/records/patients/${patient.id}` satisfies Href,
        subtitle: patient.meta?.lastUpdated
          ? DateTime.formatLocal(patient.meta.lastUpdated)
          : undefined,
      }))}
    />
  )
}
