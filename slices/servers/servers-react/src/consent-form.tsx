import { Option } from 'effect'
import { type JSX, useMemo, useState } from 'react'
import { ErrorBanner } from 'react-tundraish'
import { GrantDraft, Scope, ScopeRequest } from 'scopes-core'
import { PatientPillPicker, ScopePicker } from 'scopes-react'
import { ConsentDetails } from 'servers-core'

import type { ConsentDecision } from './consent-queries.ts'
import styles from './consent-form.module.css'

/** Props for {@link ConsentForm}. */
interface ConsentFormProps {
  /** The server the consent waits on. */
  readonly domain: string
  readonly details: ConsentDetails.Type
  /** Whether a decision is on its way to the host; the buttons wait for it. */
  readonly deciding: boolean
  /** Why the last decision failed; `null` when it didn't. */
  readonly decisionError: unknown
  readonly onDecide: (decision: ConsentDecision) => void
}

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
    <div className={styles['consent-form__warning']} role="note">
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
      <label className={styles['consent-form__acknowledge']}>
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
 * The patient the app gets: the one its standing grant names, or none when
 * the access allows it. Picking among the server's patients isn't offered.
 */
function PatientChoice({
  patient,
  needsPatient,
  value,
  onChange,
}: {
  readonly patient: Option.Option<string>
  readonly needsPatient: boolean
  readonly value: string | null
  readonly onChange: (patient: string | null) => void
}): JSX.Element {
  const patients = patient.pipe(
    Option.map((id) => [{ id, displayName: id }]),
    Option.getOrElse(() => [])
  )
  if (needsPatient && patients.length === 0) {
    return (
      <p className={styles['consent-form__note']}>
        This app asks for one patient&apos;s records, and no patient is chosen for it. Turn off that
        access below to allow the rest.
      </p>
    )
  }
  return (
    <PatientPillPicker
      patients={patients}
      value={value}
      onChange={onChange}
      onChooseNoPatient={
        needsPatient
          ? undefined
          : () => {
              onChange(null)
            }
      }
    />
  )
}

/** The scope request the picker edits for `details`: a device may be granted up to its client's registration. */
const scopeRequestFor = (details: ConsentDetails.Type): ScopeRequest.ScopeRequest =>
  details.kind === 'device'
    ? ScopeRequest.expandable({
        requested: details.requestedScopes,
        available: details.registeredScopes,
      })
    : ScopeRequest.fromRequestedScopes({ optional: details.requestedScopes })

/**
 * A waiting consent as the sheet asks it: who is asking, from where, and on
 * which server; the access asked for in plain words, which the Owner may
 * narrow (or, for a device, widen up to its registration); the patient, when
 * the access is for one; and Deny or Allow.
 */
function ConsentForm({
  domain,
  details,
  deciding,
  decisionError,
  onDecide,
}: ConsentFormProps): JSX.Element {
  const request = useMemo(() => scopeRequestFor(details), [details])
  const initialPatient = details.kind === 'oauth' ? details.patient : Option.none<string>()
  const [draft, setDraft] = useState(() =>
    GrantDraft.fromScopes(details.requestedScopes, Option.getOrNull(initialPatient))
  )
  const [acknowledged, setAcknowledged] = useState(false)
  const appName = ConsentDetails.appNameOf(details)
  const needsPatient = details.kind === 'oauth' && grantsPatientRecords(draft)
  const offersPatient = details.kind === 'oauth' && asksForPatient(draft)
  const needsAcknowledgement =
    details.kind === 'oauth' && details.registration.status !== 'registered'
  const canAllow =
    !deciding &&
    GrantDraft.hasScopes(draft) &&
    !(needsAcknowledgement && !acknowledged) &&
    !(needsPatient && draft.patient === null)

  const allow = (): void => {
    const approvedScopes = GrantDraft.serializeAll(draft)
    onDecide({
      kind: 'approve',
      approval:
        details.kind === 'device'
          ? { kind: 'device', userCode: details.userCode, approvedScopes }
          : {
              kind: 'oauth',
              id: details.id,
              approvedScopes,
              ...(offersPatient && draft.patient !== null ? { patient: draft.patient } : {}),
              acknowledgedRegistration: needsAcknowledgement && acknowledged,
            },
    })
  }
  const deny = (): void => {
    onDecide({
      kind: 'deny',
      consent:
        details.kind === 'device'
          ? { kind: 'device', userCode: details.userCode }
          : { kind: 'oauth', id: details.id },
    })
  }

  return (
    <div className={styles['consent-form']}>
      <header className={styles['consent-form__identity']}>
        <h3 className={styles['consent-form__app']}>{appName}</h3>
        <p className={styles['consent-form__server']}>
          wants access to <strong>{domain}</strong>
        </p>
        {ConsentDetails.askingFromOf(details).pipe(
          Option.map((askingFrom) => (
            <p key="asking-from" className={styles['consent-form__asking-from']}>
              {details.kind === 'device' ? 'from the device ' : 'from '}
              <code>{askingFrom}</code>
            </p>
          )),
          Option.getOrNull
        )}
        {details.kind === 'device' ? (
          <p className={styles['consent-form__asking-from']}>
            pairing code <code>{details.userCode}</code>
          </p>
        ) : null}
        <code className={styles['consent-form__client-id']}>{details.clientId}</code>
      </header>

      <ErrorBanner error={decisionError} />

      {details.kind === 'oauth' ? (
        <RegistrationAcknowledgement
          registration={details.registration}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
        />
      ) : null}

      {offersPatient ? (
        <div className={styles['consent-form__patient']}>
          <p className={styles['consent-form__eyebrow']}>Patient</p>
          <PatientChoice
            patient={initialPatient}
            needsPatient={needsPatient}
            value={draft.patient}
            onChange={(patient) => {
              setDraft((previous) => ({ ...previous, patient }))
            }}
          />
        </div>
      ) : null}

      {details.kind === 'device' ? (
        <ScopePicker
          subjectName={appName}
          request={request}
          draft={draft}
          onDraftChange={setDraft}
          mode="expandable"
          phrasing="asking"
          forcedSubject="system"
        />
      ) : (
        <ScopePicker
          subjectName={appName}
          request={request}
          draft={draft}
          onDraftChange={setDraft}
        />
      )}

      <div className={styles['consent-form__actions']}>
        <button
          type="button"
          className="button-2 outline accent-red"
          disabled={deciding}
          onClick={deny}
        >
          Deny
        </button>
        <button type="button" className="button-2 filled" disabled={!canAllow} onClick={allow}>
          Allow
        </button>
      </div>
    </div>
  )
}

export { ConsentForm, type ConsentFormProps }
