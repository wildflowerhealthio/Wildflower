import { type NotFoundRouteProps, useLocation, useNavigate } from '@tanstack/react-router'
import { GateCard } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import type { JSX } from 'react'

import { missingPatientIdOf } from './routed-patient-choice.ts'

/** Props for {@link RouteNotFound}. */
interface RouteNotFoundProps {
  /** The app as the card's title names it, e.g. `Wildflower Strength`. */
  readonly appName: string
}

/** A paused card saying what the app has no page for, offering the patient picker. */
function NothingHereCard({ title }: { readonly title: string }): JSX.Element {
  const navigate = useNavigate()
  return (
    <GateCard
      title={title}
      showSpinner={false}
      action={{
        label: 'Choose a patient',
        onClick: () => {
          void navigate({ to: '/patients' })
        },
      }}
    />
  )
}

/**
 * A routed SMART app's root `notFoundComponent`: "<app> has no page at
 * <path>." for a path no route names (a stale bookmark, `/index.html`),
 * offering the patient picker at `/patients`.
 */
function RouteNotFound({ appName }: RouteNotFoundProps): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  return <NothingHereCard title={`${appName} has no page at ${pathname}.`} />
}

/**
 * A routed SMART app's patient route's `notFoundComponent`: "<app> has no
 * patient <id>." for a patient the server does not have
 * (`ensureRoutedPatient`'s `notFound()`, its `data`), and
 * {@link RouteNotFound} for a path under the patient no route names.
 */
function PatientRouteNotFound({
  appName,
  data,
}: RouteNotFoundProps & Pick<NotFoundRouteProps, 'data'>): JSX.Element {
  return Option.match(missingPatientIdOf(data), {
    onNone: () => <RouteNotFound appName={appName} />,
    onSome: (patientId) => <NothingHereCard title={`${appName} has no patient ${patientId}.`} />,
  })
}

export { PatientRouteNotFound, RouteNotFound, type RouteNotFoundProps }
