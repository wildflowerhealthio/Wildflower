import { type Href } from 'expo-router'

import React from 'react'

import { DateTime } from 'effect'
import ItemList from '@/components/ui/item-list'
import { patients$ } from '@/livestore/queries'
import { events } from '@/livestore/schema'
import { useAppStore } from '../../livestore/store'

export default function PatientsList(): React.JSX.Element {
  const store = useAppStore()
  const patients = store.useQuery(patients$)

  return (
    <ItemList
      title="Patient Records"
      onDelete={(indices) => {
        store.commit(...indices.map((i) => events.patientDeleted({ id: patients[i].id })))
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
