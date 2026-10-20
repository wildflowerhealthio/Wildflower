import type { UseMutationResult } from '@tanstack/react-query'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import {
  ErrorBanner,
  pageLayoutStyles,
  StatusBadge,
  TextField,
} from '@wildflowerhealthio/react-tundraish'
import { GrantDraft, Scope, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import type { GrantDraft as GrantDraftModel } from '@wildflowerhealthio/scopes-core'
import { ScopePicker, type PatientOption } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  OAuthConsentDecision,
  OAuthConsentResource,
  OAuthConsentResult,
} from '../../queries/index.ts'
import { AppAvatar } from './app-avatar.tsx'
import { PatientChoice } from './patient-choice.tsx'
import { RegistrationWarning } from './registration-warning.tsx'
import styles from '../../styles/consent-card.module.css'

/**
 * What the card sends the Owner's decision through: a consent mutation's
 * `mutate`, and its pending state and failure. The card only reads these, so
 * the surface composing it decides whose session the decision runs on.
 */
type OAuthConsentMutation = Pick<
  UseMutationResult<OAuthConsentResult, Error, OAuthConsentDecision>,
  'mutate' | 'isPending' | 'error'
>

/** The patients the patient bar offers, as its composer read them. */
interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
  /** Why the patient list could not be read, or `null` when it was (or was not asked for). */
  readonly error: Error | null
}

/** The patient bar's search of the server's patients by name. */
interface PatientNameSearch {
  /** The name typed so far. */
  readonly name: string
  readonly onNameChange: (name: string) => void
}

interface OAuthConsentCardProps {
  readonly consent: OAuthConsentResource
  readonly consentMutation: OAuthConsentMutation
  /**
   * The patients the patient bar offers. Read by the composing surface, which
   * asks for them only when `consentAsksForPatient` says the bar shows.
   */
  readonly patients: PatientOptionsState
  /** A name search above the patient picker. Absent ⇒ the picker lists `patients` alone. */
  readonly patientSearch?: PatientNameSearch
  readonly onDone: (result: OAuthConsentResult) => void
  /**
   * Hand the request to the server's Owner, for a reader whose token lacks
   * some of the consent's `missingApprovalScopes`: the card offers it in place
   * of Allow, and in place of Deny too when the reader can't decide the
   * request at all.
   */
  readonly onAskOwner: () => void
}

/** The host `redirectUri` sends the browser back to, or the raw string if it doesn't parse. */
const redirectHostOf = (redirectUri: string): string => {
  try {
    return new URL(redirectUri).host
  } catch {
    return redirectUri
  }
}

/** Why the card offers "Ask the server's owner" in place of Allow. */
const CANNOT_ALLOW = "This browser can't allow this app."

/**
 * The approval scope that decides a request at all, approving or denying it
 * (`authorization-server-rust`'s `consent_decider_scopes`): a reader missing it
 * can't deny either.
 */
const DECIDING_SCOPE = 'wildflower/AuthorizationRequest.u'

/**
 * The OAuth consent card: the app-identity header with where it sends the
 * browser back to, the launch-patient bar, the shared {@link ScopePicker}
 * editing surface, and the approve/deny decision wiring. A reader lacking
 * some of the consent's `missingApprovalScopes` gets none of the patient bar,
 * registration warning or scope editing, and "Ask the server's owner" in place
 * of Allow, with no Deny when what it lacks includes deciding the request at
 * all. The scope editing
 * itself (statements ⇄ grid, exclusions, flags) is `scopes-react`'s; this card
 * owns the draft and the result routing. What sends the decision and what
 * reads the patients come from its composer: the authorization server's own
 * consent page, on the browser session.
 */
const OAuthConsentCard = ({
  consent,
  consentMutation,
  patients: patientOptions,
  patientSearch,
  onDone,
  onAskOwner,
}: OAuthConsentCardProps): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.fromRequestedScopes({ optional: consent.scopes }),
    [consent]
  )

  // The app's display identity: the registered client name, with the raw
  // client_id demoted to a small mono line (and doubling as the fallback
  // subject when registration didn't carry a name).
  const appName = consent.clientName === '' ? consent.clientId : consent.clientName

  // Deliberate behavior change: seed every *requested* scope as granted (not just the
  // pre-approved subset) — the user prunes rather than builds.
  const [draft, setDraft] = useState<GrantDraftModel.GrantDraft>(() =>
    GrantDraft.fromScopes(consent.scopes, consent.patient ?? null)
  )
  const [resultError, setResultError] = useState<string | null>(null)
  const [patientError, setPatientError] = useState<string | null>(null)
  // The trust-on-first-use acknowledgment: required before Approve is enabled
  // whenever `registration.status` is `new`/`changed`; irrelevant (and never
  // shown) for `registered`, so it always sends `false` in that case.
  const [registrationAcknowledged, setRegistrationAcknowledged] = useState(false)
  const registrationNeedsAcknowledgment = consent.registration.status !== 'registered'
  // A reader whose token lacks an approval scope (to decide the request, to
  // create the grant or write the client registration, or a resource scope
  // the request asks for) can't allow; the server would refuse it. One that
  // can't decide the request at all can't deny it either.
  const canAllow = consent.missingApprovalScopes.length === 0
  const canDeny = !consent.missingApprovalScopes.includes(DECIDING_SCOPE)
  const { options: patients, loading: patientsLoading, error: patientsError } = patientOptions
  // The patient the Owner picked, kept so the picker still names them once a
  // later name search no longer lists them.
  const [pickedPatient, setPickedPatient] = useState<PatientOption | null>(null)
  const pickablePatients =
    pickedPatient !== null &&
    pickedPatient.id === draft.patient &&
    !patients.some((patient) => patient.id === pickedPatient.id)
      ? [pickedPatient, ...patients]
      : patients

  // Whether a FHIR patient-context scope is still granted in the *current draft*.
  // The requirement to supply a launch patient tracks this, not the original
  // request: while any patient-context scope remains, a patient must be chosen —
  // so the picker offers no "No patient" escape hatch.
  const draftHasPatientContextScope = useMemo(
    () =>
      Scope.MultiScope.fhirScopes(draft).some((scope) =>
        scope.hasContext(Scope.Contexts.Fhir.patient)
      ),
    [draft]
  )
  // Whether the current draft asks for a launch patient at all: a patient-context
  // scope, or `launch/patient`. With `launch/patient` alone the patient is
  // optional — the picker offers "No patient". If the user prunes both, the
  // picker disappears and no patient is sent.
  const draftHasPatientScope =
    draftHasPatientContextScope || draft.known.some((known) => known.name === 'launch/patient')

  const patientBarRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  const submitting = consentMutation.isPending
  // A result message (a denial / result error) takes precedence over the raw
  // mutation error; `ErrorBanner` renders whichever is set. A `403
  // InsufficientScope` (approving a resource scope the approver's own token
  // doesn't cover) renders as the app's permission surface, which offers a
  // step-up sign-in that returns here to approve again.
  const error = resultError ?? consentMutation.error
  const hasError = resultError !== null || consentMutation.error !== null

  // The error banner sits at the top of the card, but the buttons that trigger
  // it are at the bottom — scroll it into view whenever an error appears *or
  // changes* (e.g. a mutation error replaced by a fresh denial message) so a
  // scrolled-down user sees why their approval/denial didn't go through. Keyed on
  // the rendered error identity, not a boolean, so a swap between two non-null
  // errors still re-scrolls.
  useEffect(() => {
    if (error !== null) {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [error])

  const handleApprove = (): void => {
    setResultError(null)
    // A patient-context grant needs a launch patient — surface the miss beside
    // the patient bar instead of sending a patientless approval. This holds even
    // when there is no patient to pick (an empty or unreadable list): the way
    // forward then is to prune the patient-context scopes, not to approve without one.
    if (draftHasPatientContextScope && draft.patient === null) {
      setPatientError('Select a patient to continue.')
      patientBarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    consentMutation.mutate(
      {
        kind: 'approve',
        id: consent.id,
        payload: {
          approvedScopes: GrantDraft.serializeAll(draft),
          // Only bind a launch patient when the draft still grants a patient-context
          // scope or `launch/patient`; a patient chosen before pruning both is dropped.
          patient: draftHasPatientScope ? draft.patient : null,
          // `registered` shows no checkbox and always sends `false`; the server
          // ignores the flag for that status anyway.
          acknowledgedRegistrationChange:
            registrationNeedsAcknowledgment && registrationAcknowledged,
        },
      },
      {
        // The server records an approval that keeps none of the requested
        // scopes as a denial. Either way the request is decided, so both leave
        // the card with the result, which carries the client's callback.
        onSuccess: (result) => {
          if (result.status === 'approved' || result.status === 'denied') {
            onDone(result)
          } else {
            setResultError(result.message)
          }
        },
      }
    )
  }

  const handleDecline = (): void => {
    setResultError(null)
    consentMutation.mutate(
      { kind: 'deny', id: consent.id },
      {
        onSuccess: (result) => {
          if (result.status === 'denied' || result.status === 'approved') {
            onDone(result)
          } else {
            setResultError(result.message)
          }
        },
      }
    )
  }

  return (
    <section className={styles['card']}>
      <header className={styles['header']}>
        <AppAvatar name={appName} redirectUri={consent.redirectUri} />
        <div className={styles['identity']}>
          <h2 className={styles['name']}>{appName}</h2>
          <p className={styles['subtitle']}>wants to connect to your health records</p>
          <code className={styles['client-id']}>{consent.clientId}</code>
          <p className={styles['redirect-host']}>
            Returns you to <code>{redirectHostOf(consent.redirectUri)}</code>
          </p>
        </div>
        <StatusBadge tone="info">Review request</StatusBadge>
      </header>

      {hasError ? (
        <div ref={errorRef} className={styles['result-error']}>
          <ErrorBanner error={error} />
        </div>
      ) : null}

      {/* A reader who can't allow gets none of the decision's controls: they
          only shape an approval it can't make. */}
      {canAllow && draftHasPatientScope ? (
        <div className={styles['patient-bar']} ref={patientBarRef}>
          <p className={styles['eyebrow']}>Patient</p>
          {patientSearch !== undefined ? (
            <TextField
              className={styles['patient-search']}
              label="Find a patient"
              type="search"
              inputMode="search"
              placeholder="Name"
              value={patientSearch.name}
              onChange={patientSearch.onNameChange}
            />
          ) : null}
          <PatientChoice
            patients={pickablePatients}
            loading={patientsLoading}
            error={patientsError}
            value={draft.patient}
            optional={!draftHasPatientContextScope}
            searchedName={patientSearch?.name.trim() ?? ''}
            onChange={(patientId) => {
              setPatientError(null)
              setPickedPatient(pickablePatients.find((patient) => patient.id === patientId) ?? null)
              setDraft((previous) => ({ ...previous, patient: patientId }))
            }}
          />
          {patientError !== null && draftHasPatientContextScope ? (
            <p
              className={cn(pageLayoutStyles['error'], styles['patient-error'], 'text-body-3')}
              role="alert"
            >
              {patientError}
            </p>
          ) : null}
        </div>
      ) : null}

      {canAllow ? (
        <>
          <RegistrationWarning
            registration={consent.registration}
            clientId={consent.clientId}
            redirectUri={consent.redirectUri}
            acknowledged={registrationAcknowledged}
            onAcknowledgeChange={setRegistrationAcknowledged}
          />
          <ScopePicker
            subjectName={appName}
            request={request}
            draft={draft}
            onDraftChange={setDraft}
          />
        </>
      ) : null}

      <div className={styles['footer']}>
        {/* Stopgap until the FHIR server enforces patient compartments (#416):
            a patient-context scope is checked like a system one. Tracks the
            draft, so it goes once every patient-context scope is unticked. */}
        {canAllow && draftHasPatientContextScope ? (
          <p role="note" className={styles['patient-scope-warning']}>
            This server can't yet limit an app to one patient. If you allow this, the app can read
            the records it asks for for every patient on this server.
          </p>
        ) : null}
        {canAllow ? null : (
          <p role="note" className={styles['ask-owner-reason']}>
            {CANNOT_ALLOW}
          </p>
        )}
        <div className={styles['buttons']}>
          {canDeny ? (
            <button
              type="button"
              className={cn('button-2 outline accent-red', styles['deny'])}
              disabled={submitting}
              onClick={handleDecline}
            >
              Deny
            </button>
          ) : null}
          {canAllow ? (
            <button
              type="button"
              className={cn('button-2 filled', styles['allow'])}
              // A fully-pruned draft serializes to no scopes, which the backend
              // treats as a deny — block the approve action rather than let an
              // empty grant submit as an accidental denial. A `new`/`changed`
              // registration additionally gates on the acknowledgment checkbox.
              disabled={
                submitting ||
                !GrantDraft.hasScopes(draft) ||
                (registrationNeedsAcknowledgment && !registrationAcknowledged)
              }
              onClick={handleApprove}
            >
              Allow access
            </button>
          ) : (
            <button
              type="button"
              className={cn('button-2 filled', styles['allow'])}
              disabled={submitting}
              onClick={onAskOwner}
            >
              Ask the server's owner
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export { OAuthConsentCard }
export type { OAuthConsentCardProps, OAuthConsentMutation, PatientNameSearch, PatientOptionsState }
