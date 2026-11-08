import type { SmartConnection } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  LoadingLine,
  PatientChoiceLine,
  PatientPicker,
  patientChoiceKeyOf,
  SmartHandshakeGate,
  usePatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'
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
 * record the chat reads, under the title, then the picker or the chosen
 * patient's page. The chat is not built yet, so that page says so.
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
          // Keyed per choice, so a change of patient starts the page afresh.
          <p key={patientChoiceKeyOf(chosen)} className={styles.note}>
            Chat comes next.
          </p>
        )),
        Option.getOrElse(() => (
          <PatientPicker key="patient-picker" onPatientChoice={choosePatient} />
        ))
      )}
    </>
  )
}
