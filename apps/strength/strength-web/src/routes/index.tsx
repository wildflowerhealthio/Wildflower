import { createFileRoute, redirect } from '@tanstack/react-router'
import { PATIENT_PARAM, routedPatientChoiceOf } from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'

/**
 * `/` itself, which opens the chosen patient's first tab, replacing the bare
 * path in history, so Back leaves the page (or returns to the patient
 * before) rather than landing on it again: Today for a lifter, and History
 * for All patients, whose Today only asks for a patient. A patient choice
 * navigates here, so each choice opens on its first tab.
 *
 * @remarks
 * With no patient chosen yet it stays: the root shows the patient picker in
 * place of the tabs, and choosing navigates back here with the choice.
 */
const Route = createFileRoute('/')({
  beforeLoad: ({ search, context }) => {
    const patientChoice = routedPatientChoiceOf(search[PATIENT_PARAM], context.client.patient.id)
    if (Option.isNone(patientChoice)) return
    throw redirect({
      to: patientChoice.value.kind === 'patient' ? '/today' : '/history',
      replace: true,
    })
  },
})

export { Route }
