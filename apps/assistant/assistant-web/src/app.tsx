import { useQuery } from '@tanstack/react-query'
import { AssistantChat } from '@wildflowerhealthio/assistant-react'
import {
  type RunSmart,
  type SmartConnection,
  useRunSmart,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import type { Scope } from '@wildflowerhealthio/scopes-core'
import {
  LoadingLine,
  type PatientChoice,
  PatientChoiceLine,
  PatientPicker,
  patientChoiceKeyOf,
  patientNameOf,
  patientQuery,
  ReadFailureLine,
  SmartHandshakeGate,
  useGrantedScopes,
  usePatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import styles from './app.module.css'

/**
 * The redirect-target app: completes the SMART handshake under
 * `SmartHandshakeGate`, settles on whose record the chat reads, and shows the
 * page for it.
 *
 * @remarks
 * Whose record is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`connection.launchPatientId`); with
 * neither the page is the `PatientPicker`, "All patients" first. The
 * `PatientChoiceLine` under the title names the choice and goes back to the
 * picker. The title sits above the gate, so it shows while the handshake
 * connects and when it fails.
 */
export const App = (): JSX.Element => (
  <main className={styles.app}>
    <header className={styles.header}>
      <h1 className="text-heading-3">Wildflower Assistant</h1>
    </header>
    <SmartHandshakeGate connecting={<LoadingLine />}>
      {({ connection }) => <AssistantPage connection={connection} />}
    </SmartHandshakeGate>
  </main>
)

/**
 * The page over a completed handshake's `connection`: the line naming whose
 * record the chat reads, under the title, then the picker or the chat about
 * the chosen patient.
 */
const AssistantPage = ({ connection }: { readonly connection: SmartConnection }): JSX.Element => {
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(
    connection.launchPatientId
  )

  return (
    <>
      {patientChoice.pipe(
        Option.map((chosen) => (
          <PatientChoiceLine
            key="patient-line"
            className={styles['patient-line']}
            patientChoice={chosen}
            onPatientChange={changePatient}
          />
        )),
        Option.getOrNull
      )}
      {patientChoice.pipe(
        Option.map((chosen) => (
          // Keyed per choice, so a change of patient starts the chat afresh.
          <PatientChat
            key={patientChoiceKeyOf(chosen)}
            fhirBaseUrl={connection.fhirBaseUrl}
            patientChoice={chosen}
          />
        )),
        Option.getOrElse(() => (
          <PatientPicker key="patient-picker" onPatientChoice={choosePatient} />
        ))
      )}
    </>
  )
}

/**
 * The chat about `patientChoice`'s record on `fhirBaseUrl`: for one patient,
 * once the `Patient` read the choice line also makes has landed, so the chat
 * can state the patient's name and birth date; for "All patients", at once.
 * Its tools are the ones the sign-in's granted scopes allow, reading over
 * the page's SMART runtime.
 */
const PatientChat = ({
  fhirBaseUrl,
  patientChoice,
}: {
  readonly fhirBaseUrl: string
  readonly patientChoice: PatientChoice
}): JSX.Element => {
  const grantedScopes = useGrantedScopes()
  const runSmart = useRunSmart()
  return Match.value(patientChoice).pipe(
    Match.when({ kind: 'patient' }, ({ patientId }) => (
      <OnePatientChat
        fhirBaseUrl={fhirBaseUrl}
        patientId={patientId}
        grantedScopes={grantedScopes}
        runSmart={runSmart}
      />
    )),
    Match.when({ kind: 'all-patients' }, () => (
      <AssistantChat
        fhirBaseUrl={fhirBaseUrl}
        patient={{ kind: 'all-patients' }}
        grantedScopes={grantedScopes}
        runSmart={runSmart}
      />
    )),
    Match.exhaustive
  )
}

/** The chat about one patient, once that patient's record has been read. */
const OnePatientChat = ({
  fhirBaseUrl,
  patientId,
  grantedScopes,
  runSmart,
}: {
  readonly fhirBaseUrl: string
  readonly patientId: string
  readonly grantedScopes: readonly Scope.Any[]
  readonly runSmart: RunSmart
}): JSX.Element => {
  const patientRead = useQuery(patientQuery(runSmart, patientId))
  if (patientRead.isError) {
    return <ReadFailureLine subject="the patient" error={patientRead.error} />
  }
  if (patientRead.data === undefined) return <LoadingLine subject="the patient" />
  if (Option.isNone(patientRead.data)) {
    return (
      <ReadFailureLine subject={`patient ${patientId}`} error="no such patient on this server" />
    )
  }
  const patient = patientRead.data.value
  return (
    <AssistantChat
      fhirBaseUrl={fhirBaseUrl}
      patient={{
        kind: 'patient',
        patientId,
        name: patientNameOf(patient),
        birthDate: Option.fromNullable(patient.birthDate),
      }}
      grantedScopes={grantedScopes}
      runSmart={runSmart}
    />
  )
}
