import { Href } from 'expo-router'

import React from 'react'

import { DateTime } from 'effect'
import { patients$ } from 'fhir-r4-livestore/queries'
import ItemList from '@/components/ui/item-list'
import { useAppStore } from '../../livestore/store'

export default function PatientsList(): React.JSX.Element {
  const store = useAppStore()
  const patients = store.useQuery(patients$)

  return (
    <ItemList
      title="Patient Records"
      onDelete={() => {}}
      items={patients.map((patient) => ({
        id: patient.id!,
        title: patient.meta?.source || 'Patient Record',
        destination: `/records/patients/${patient.id}` satisfies Href,
        subtitle: patient.meta?.lastUpdated
          ? DateTime.formatLocal(patient.meta.lastUpdated)
          : undefined,
      }))}
    />
  )
}
