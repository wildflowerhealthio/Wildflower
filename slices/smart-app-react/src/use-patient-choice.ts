import { Option } from 'effect'
import { useCallback, useMemo, useState } from 'react'

import { decodePatientChoice, type PatientChoice, withPatientChoice } from './patient-choice.ts'

/** What {@link usePatientChoice} hands the page. */
interface PatientChoosing {
  /**
   * Whose records the page reads; `None` while the reader is choosing, which
   * the page shows as the `PatientPicker`.
   */
  readonly patientChoice: Option.Option<PatientChoice>
  /** Settle on `patientChoice`: the picker's `onPatientChoice`. */
  readonly choosePatient: (patientChoice: PatientChoice) => void
  /** Go back to the picker: the `PatientChoiceLine`'s "Change patient". */
  readonly changePatient: () => void
}

/** Put `patientChoice` in the address bar, keeping every other query key. */
const writePatientChoiceToUrl = (patientChoice: PatientChoice): void => {
  const url = new URL(window.location.href)
  url.search = withPatientChoice(url.searchParams, patientChoice).toString()
  window.history.replaceState(window.history.state, '', url)
}

/**
 * The patient a SMART app reads for, chosen in the app: the URL's
 * `?patient=` when it carries one, else the launch's patient, else none yet.
 *
 * @param launchPatientId - The patient the launch's token carries
 *   (`client.patient.id`, e.g. an EHR launch from a patient's record), or
 *   `null` — with no patient in context, or before the handshake completes.
 *
 * @remarks
 * The URL is read once, when the page opens, and wins over the launch's
 * patient: it holds the reader's own choice, which a reload must not undo. A
 * choice is written back as `?patient=<id>` (or `?patient=*` for every
 * patient) through `history.replaceState`, touching no other query key, so
 * an app's own URL state sits beside it. Nothing is written until the reader
 * chooses: before the handshake completes the URL still carries the OAuth
 * `code` / `state` fhirclient reads.
 *
 * Changing the patient only reopens the picker; the URL keeps the last
 * choice until another is made, so a reload mid-change returns to it.
 */
const usePatientChoice = (launchPatientId: string | null): PatientChoosing => {
  const [chosenPatient, setChosenPatient] = useState(() =>
    decodePatientChoice(new URLSearchParams(window.location.search))
  )
  const [isChanging, setIsChanging] = useState(false)

  const choosePatient = useCallback((patientChoice: PatientChoice) => {
    writePatientChoiceToUrl(patientChoice)
    setChosenPatient(Option.some(patientChoice))
    setIsChanging(false)
  }, [])
  const changePatient = useCallback(() => {
    setIsChanging(true)
  }, [])

  // Memoised so a page can key a memo or an effect on the choice.
  const patientChoice = useMemo(
    (): Option.Option<PatientChoice> =>
      isChanging
        ? Option.none()
        : Option.orElse(chosenPatient, () =>
            Option.map(Option.fromNullable(launchPatientId), (patientId): PatientChoice => ({
              kind: 'patient',
              patientId,
            }))
          ),
    [isChanging, chosenPatient, launchPatientId]
  )
  return { patientChoice, choosePatient, changePatient }
}

export { type PatientChoosing, usePatientChoice }
