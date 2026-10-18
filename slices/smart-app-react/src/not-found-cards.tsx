import { useLocation, useNavigate } from '@tanstack/react-router'
import { GateCard } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { usePathPatientId } from './patient-route.ts'

/** A paused card saying what there is nothing at, offering the patient picker. */
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
 * A routed SMART app's root `notFoundComponent`: "There's no page at
 * <path>." for a path no route names (a stale bookmark, `/index.html`),
 * offering the patient picker at `/patients`.
 *
 * @remarks
 * The app's router sets `notFoundMode: 'root'`, so every unmatched path,
 * one under a patient too, comes here.
 */
function NoPageCard(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  return <NothingHereCard title={`There's no page at ${pathname}.`} />
}

/**
 * A routed SMART app's patient route's `notFoundComponent`: "This server has
 * no patient <id>." for the patient the path names, which the server does
 * not have (`requirePatient`'s `notFound()`), offering the patient picker.
 */
function NoPatientCard(): JSX.Element {
  const patientId = usePathPatientId()
  return (
    <NothingHereCard
      title={
        patientId === undefined
          ? 'This server has no such patient.'
          : `This server has no patient ${patientId}.`
      }
    />
  )
}

export { NoPageCard, NoPatientCard }
