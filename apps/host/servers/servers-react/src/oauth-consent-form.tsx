import { GrantDraft, Scope, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import { PatientPillPicker, ScopePicker } from '@wildflowerhealthio/scopes-react'
import { ConsentApproval, ConsentDetails } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import { type JSX, useMemo, useState } from 'react'

import { ConsentFormLayout, type ConsentFormProps } from './consent-form-layout.tsx'
import styles from './oauth-consent-form.module.css'

/** Whether `draft` grants any FHIR access scoped to one patient. */
const grantsPatientRecords = (draft: GrantDraft.GrantDraft): boolean =>
  Scope.MultiScope.fhirScopes(draft).some((scope) => scope.hasContext(Scope.Contexts.Fhir.patient))

/** Whether `draft` asks for a launch patient: patient-scoped records, or `launch/patient`. */
const asksForPatient = (draft: GrantDraft.GrantDraft): boolean =>
  grantsPatientRecords(draft) || draft.known.some((known) => known.name === 'launch/patient')

/**
 * The trust-on-first-use warning for an app that is new to the server, or
 * whose redirect or scopes step outside its registration, with the
 * acknowledgement approving it needs. Nothing for a registered app.
 */
function RegistrationAcknowledgement({
  registration,
  acknowledged,
  onAcknowledgedChange,
}: {
  readonly registration: ConsentDetails.Registration
  readonly acknowledged: boolean
  readonly onAcknowledgedChange: (acknowledged: boolean) => void
}): JSX.Element | null {
  if (registration.status === 'registered') return null
  return (
    <div className={styles['oauth-consent-form__warning']} role="note">
      <p>
        {registration.status === 'new'
          ? 'This server has never seen this app. Allowing it registers the app with the access you allow.'
          : "This app's request differs from its registration."}
      </p>
      {registration.status === 'changed' && registration.redirectUriIsNew ? (
        <p>It answers at an address it hasn't used before.</p>
      ) : null}
      {registration.status === 'changed' && registration.newScopes.length > 0 ? (
        <p>It asks for access it wasn't registered for.</p>
      ) : null}
      <label className={styles['oauth-consent-form__acknowledge']}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            onAcknowledgedChange(event.target.checked)
          }}
        />
        I recognise this app and the address it answers at
      </label>
    </div>
  )
}

/**
 * The patient the app gets: the one its launch binds, which the approval must
 * name, or none when the app wasn't launched for one and the access allows it.
 * Picking among the server's patients isn't offered.
 */
function PatientChoice({
  launchPatient,
  needsPatient,
  value,
  onChange,
}: {
  readonly launchPatient: Option.Option<string>
  readonly needsPatient: boolean
  readonly value: string | null
  readonly onChange: (patient: string | null) => void
}): JSX.Element {
  const patients = launchPatient.pipe(
    Option.map((id) => [{ id, displayName: id }]),
    Option.getOrElse(() => [])
  )
  if (needsPatient && patients.length === 0) {
    return (
      <p className={styles['oauth-consent-form__note']}>
        This app asks for one patient&apos;s records, and wasn&apos;t launched for a patient. Turn
        off that access below to allow the rest.
      </p>
    )
  }
  return (
    <PatientPillPicker
      patients={patients}
      value={value}
      onChange={onChange}
      onChooseNoPatient={
        needsPatient || Option.isSome(launchPatient)
          ? undefined
          : () => {
              onChange(null)
            }
      }
    />
  )
}

/**
 * An app's `/authorize` as the sheet asks it: where the app answers, the
 * warning a new or changed registration needs acknowledged, the patient when
 * the access is for one, the access it asked for in plain words, which the
 * Owner may narrow, and Deny or Allow.
 */
function OAuthConsentForm(props: ConsentFormProps<ConsentDetails.OAuth>): JSX.Element {
  const { details } = props
  const request = useMemo(
    () => ScopeRequest.fromRequestedScopes({ optional: details.requestedScopes }),
    [details]
  )
  const [draft, setDraft] = useState(() =>
    GrantDraft.fromScopes(details.requestedScopes, Option.getOrNull(details.launchPatient))
  )
  const [acknowledged, setAcknowledged] = useState(false)
  const needsPatient = grantsPatientRecords(draft)
  // An approval of a request whose launch bound a patient must name that
  // patient, whatever access the Owner leaves on.
  const offersPatient = Option.isSome(details.launchPatient) || asksForPatient(draft)
  const needsAcknowledgement = details.registration.status !== 'registered'
  const canAllow =
    GrantDraft.hasScopes(draft) &&
    !(needsAcknowledgement && !acknowledged) &&
    !(needsPatient && draft.patient === null)

  return (
    <ConsentFormLayout
      {...props}
      requestLines={
        <p>
          from <code>{details.redirectUri.origin}</code>
        </p>
      }
      canAllow={canAllow}
      approval={() =>
        ConsentApproval.ofOAuth(details, {
          approvedScopes: GrantDraft.serializeAll(draft),
          patient: offersPatient ? Option.fromNullable(draft.patient) : Option.none(),
          acknowledged,
        })
      }
    >
      <RegistrationAcknowledgement
        registration={details.registration}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
      />
      {offersPatient ? (
        <div className={styles['oauth-consent-form__patient']}>
          <p className={styles['oauth-consent-form__eyebrow']}>Patient</p>
          <PatientChoice
            launchPatient={details.launchPatient}
            needsPatient={needsPatient}
            value={draft.patient}
            onChange={(patient) => {
              setDraft((previous) => ({ ...previous, patient }))
            }}
          />
        </div>
      ) : null}
      <ScopePicker
        subjectName={ConsentDetails.appNameOf(details)}
        request={request}
        draft={draft}
        onDraftChange={setDraft}
      />
    </ConsentFormLayout>
  )
}

export { OAuthConsentForm }
