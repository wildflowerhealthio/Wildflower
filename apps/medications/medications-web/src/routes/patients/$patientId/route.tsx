import { createFileRoute } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import { LoadingLine, NoPatientCard, requirePatient } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { MedicationsPage } from '../../-medications-page.tsx'

/** One patient's medications page, its tabs under `/patients/$patientId`. */
function PatientMedications(): JSX.Element {
  const { patientId } = Route.useParams()
  return (
    <MedicationsPage
      patientChoice={{ kind: 'patient', patientId }}
      tabs={
        <RouteTabs
          tabs={[
            { to: '/patients/$patientId/medications', params: { patientId }, label: 'Medications' },
            { to: '/patients/$patientId/calendar', params: { patientId }, label: 'Calendar' },
            {
              to: '/patients/$patientId/interactions',
              params: { patientId },
              label: 'Interactions',
            },
            { to: '/patients/$patientId/savings', params: { patientId }, label: 'Savings' },
          ]}
          aria-label="Medication views"
        />
      }
    />
  )
}

/**
 * `/patients/$patientId`, one patient's medications page, whose tabs are its
 * child routes.
 *
 * @remarks
 * The loader reads the patient first (`requirePatient`, on the cache
 * the patient line reads), so an id the server has no patient under shows
 * the no-patient card in place of the page, and a read still running
 * after a second a loading line. The page remounts per patient
 * (`remountDeps`), so nothing one patient's tabs hold carries over to the
 * next.
 */
const Route = createFileRoute('/patients/$patientId')({
  loader: ({ context: { queryClient, client }, params: { patientId } }) =>
    requirePatient(queryClient, client, patientId),
  remountDeps: ({ params }) => params.patientId,
  pendingComponent: () => <LoadingLine subject="the patient" />,
  component: PatientMedications,
  notFoundComponent: NoPatientCard,
})

export { Route }
