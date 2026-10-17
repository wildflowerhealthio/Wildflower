import { createFileRoute } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import {
  ensureRoutedPatient,
  LoadingLine,
  PatientRouteNotFound,
} from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { PatientStatus } from '../../-patient-status.tsx'

/**
 * One lifter's page: whose record it is, over the tabs, each a child route
 * the strip links to: Today, the workout due (or a program's start); Plan,
 * the program editor; Workouts, the completed workouts.
 *
 * @remarks
 * The app holds no lifting logic: reads go through `fhir-r4-react/smart`'s
 * page readers into `strength-core-js`'s schemas (`readTrainingRecord`), each
 * screen is a `strength-react` view over plain props, and each write is what
 * `strength-core-js` returns, in one batch. While any write is pending every
 * screen's controls are disabled, so two writes never race.
 */
function LifterPage(): JSX.Element {
  const { patientId } = Route.useParams()
  return (
    <>
      <PatientStatus patientChoice={{ kind: 'patient', patientId }} />
      <RouteTabs
        tabs={[
          { to: '/patients/$patientId/today', params: { patientId }, label: 'Today' },
          { to: '/patients/$patientId/plan', params: { patientId }, label: 'Plan' },
          { to: '/patients/$patientId/workouts', params: { patientId }, label: 'Workouts' },
        ]}
        aria-label="Strength views"
      />
    </>
  )
}

/**
 * `/patients/$patientId`, one lifter's page, whose tabs are its child
 * routes.
 *
 * @remarks
 * The loader reads the patient first (`ensureRoutedPatient`, on the cache
 * the patient line reads), so an id the server has no patient under shows
 * the not-found card in place of the page, and a read still running
 * after a second a loading line. The page remounts per lifter
 * (`remountDeps`): nothing one lifter's screens hold carries over to the
 * next, by Back or Forward or a link.
 */
const Route = createFileRoute('/patients/$patientId')({
  loader: ({ context: { queryClient, client }, params: { patientId } }) =>
    ensureRoutedPatient(queryClient, client, patientId),
  remountDeps: ({ params }) => params.patientId,
  pendingComponent: () => <LoadingLine subject="the patient" />,
  component: LifterPage,
  notFoundComponent: ({ data }) => (
    <PatientRouteNotFound appName="Wildflower Strength" data={data} />
  ),
})

export { Route }
