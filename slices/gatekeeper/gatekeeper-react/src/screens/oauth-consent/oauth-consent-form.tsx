import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles, StatusBadge } from 'react-tundraish'
import { GrantDraft, Rows, Scope, ScopeRequest, Sections } from 'scopes-core'
import type { GrantDraft as GrantDraftModel } from 'scopes-core'
import {
  ExclusionRow,
  FlagToggleRow,
  PermissionGrid,
  PermissionPicker,
  pickerItemsFor,
  PermissionStatement,
} from 'scopes-react'

import { Equal } from 'effect'
import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
import { exclusionStatements } from './exclusion-statements.ts'
import { PatientPillPicker } from './patient-pill-picker.tsx'
import { usePatientOptions } from './use-patient-options.ts'
import styles from '../../styles/consent-card.module.css'

interface OAuthConsentFormProps {
  readonly consent: OAuthConsentResource
  readonly onDone: (result: OAuthConsentResult) => void
}

/** Which projection the form is showing — plain-language statements or the resource×interaction grid. */
type View = 'plain' | 'detail'

/** Whether a section addresses the launch patient's own records (FHIR, patient context). */
const isPatientSection = (section: Sections.Any): boolean =>
  Equal.equals(section.context, Scope.Contexts.Fhir.patient)

/** The FHIR heading for a context level (`spec.md §8` — `system` always names its all-patients reach). */
const fhirTitle = (level: Scope.Contexts.Fhir.Level, multipleContexts: boolean): string => {
  if (level === 'system') return 'Health records — all patients'
  if (!multipleContexts) return 'Health records'
  return level === 'patient' ? 'Health records — this patient' : 'Health records — your access'
}

/** Section heading (serif). */
const sectionTitle = (section: Sections.Any, multipleContexts: boolean): string =>
  section.kind === 'wildflower'
    ? 'Wildflower admin'
    : fhirTitle(section.context.context, multipleContexts)

/** Section tag chip (`FHIR` / `Admin`). */
const sectionChip = (section: Sections.Any): string =>
  section.kind === 'wildflower' ? 'Admin' : 'FHIR'

/**
 * The lead-in phrase for the running statement list: the app is the subject of
 * the first sentence, "It can also" carries the second, and later rows fall
 * back to a minimal "…and" so a long request doesn't chant the same phrase.
 */
const subjectPhraseFor = (appName: string, index: number): string => {
  if (index === 0) return `${appName} can`
  if (index === 1) return 'It can also'
  return '…and'
}

const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.fromRequestedScopes({ optional: consent.scopes }),
    [consent]
  )
  const sections = useMemo(() => Sections.fromRequest(request), [request])
  // Whether FHIR scopes span more than one context level — the section titles then
  // disambiguate ("this patient" / "your access").
  const multipleContexts = useMemo(() => {
    const fhirScopes = [...request.requested.fhirV1, ...request.requested.fhirV2]
    return new Set(fhirScopes.map((scope) => scope.context.serialize())).size > 1
  }, [request])
  const flags = useMemo(() => Scope.Known.inCanonicalOrder(request.requested.known), [request])
  const exclusions = useMemo(() => exclusionStatements(request), [request])

  // The app's display identity: the registered client name, with the raw
  // client_id demoted to a small mono line (and doubling as the fallback
  // subject when registration didn't carry a name).
  const appName = consent.clientName === '' ? consent.clientId : consent.clientName

  // The launch-patient picker matters when a FHIR patient-context scope or `launch/patient`
  // is requested.
  const hasPatientScope = useMemo(
    () =>
      Scope.MultiScope.fhirScopes(request.requested).some((scope) =>
        scope.hasContext(Scope.Contexts.Fhir.patient)
      ) || request.requested.known.some((known) => known.name === 'launch/patient'),
    [request]
  )

  const consentMutation = useOAuthConsentMutation()
  // Deliberate behavior change: seed every *requested* scope as granted (not just the
  // pre-approved subset) — the user prunes rather than builds.
  const [draft, setDraft] = useState<GrantDraftModel.GrantDraft>(() =>
    GrantDraft.fromScopes(consent.scopes, consent.patient ?? null)
  )
  const [view, setView] = useState<View>('plain')
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const { options: patients } = usePatientOptions(hasPatientScope)

  const grids = useMemo(
    () =>
      sections.map((section) => ({
        section,
        rows: Rows.build(section, draft, request, { includeWildcard: true }),
      })),
    [sections, draft, request]
  )

  const serialized = useMemo(() => GrantDraft.serializeAll(draft), [draft])

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  const errorMessage = resultError ?? mutationError

  const toggleCell = (
    section: Sections.Any,
    resource: Scope.MultiScope.ResourceOf<Scope.MultiScope.Kind>,
    itemId: Scope.MultiScope.InteractionOf<Scope.MultiScope.Kind>
  ): void => {
    setDraft((previous) =>
      GrantDraft.toggleItem(previous, section.configuration, section.context, resource, itemId)
    )
  }

  const toggleUnknown = (scope: Scope.Unknown): void => {
    setDraft((previous) => ({
      ...previous,
      unknown: previous.unknown.some(Equal.equals(scope))
        ? previous.unknown.filter((unknown) => !Equal.equals(unknown, scope))
        : [...previous.unknown, scope],
    }))
  }

  const handleApprove = (): void => {
    setResultError(null)
    consentMutation.mutate(
      {
        kind: 'approve',
        id: consent.id,
        payload: { approvedScopes: serialized, patient: draft.patient },
      },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone(result)
          } else if (result.status === 'denied') {
            setResultError('Authorization request was denied.')
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

  // A single running index across all sections drives the lead-in phrases.
  let statementIndex = 0

  const viewToggle = (
    <button
      type="button"
      className={styles['view-toggle']}
      onClick={() => {
        setView((current) => (current === 'plain' ? 'detail' : 'plain'))
      }}
    >
      {view === 'plain' ? 'See exactly what’s granted ▸' : '◂ Back to summary'}
    </button>
  )

  return (
    <section className={styles['card']}>
      <header className={styles['header']}>
        <div aria-hidden="true" className={styles['avatar']}>
          {appName.slice(0, 1).toUpperCase()}
        </div>
        <div className={styles['identity']}>
          <h2 className={styles['name']}>{appName}</h2>
          <p className={styles['subtitle']}>wants to connect to your health records</p>
          <code className={styles['client-id']}>{consent.clientId}</code>
        </div>
        <StatusBadge tone="info">Review request</StatusBadge>
      </header>

      {hasPatientScope && patients.length > 0 ? (
        <div className={styles['patient-bar']}>
          <p className={styles['eyebrow']}>Patient</p>
          <PatientPillPicker
            patients={patients}
            value={draft.patient}
            onChange={(patientId) => {
              setDraft((previous) => ({ ...previous, patient: patientId }))
            }}
          />
        </div>
      ) : null}

      {view === 'plain' ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>What it&apos;s asking for</p>
          {grids.map(({ section, rows }) =>
            rows.map((row) => {
              const rowKey = `${Sections.scopePrefix(section)}/${row.resource.serialize()}`
              const label = row.resource.singularLabel()
              const items = pickerItemsFor(section.configuration, row)
              const grantedNames = items
                .filter((item) => item.state === 'on' || item.state === 'locked')
                .map((item) => item.name)
              const subject = subjectPhraseFor(appName, statementIndex)
              statementIndex += 1
              return (
                <PermissionStatement
                  key={rowKey}
                  subjectPhrase={subject}
                  connector={isPatientSection(section) ? 'your' : undefined}
                  verbText={grantedNames.length === 0 ? 'not access' : grantedNames.join(' · ')}
                  resourceLabel={label}
                  open={openRow === rowKey}
                  onToggleOpen={() => {
                    setOpenRow((current) => (current === rowKey ? null : rowKey))
                  }}
                >
                  <PermissionPicker
                    items={items}
                    variant="plain"
                    ariaLabel={`Permissions on ${label}`}
                    onToggle={(itemId) => {
                      toggleCell(section, row.resource, itemId)
                    }}
                  />
                </PermissionStatement>
              )
            })
          )}
          {viewToggle}
        </div>
      ) : (
        <div className={styles['section']}>
          {grids.map(({ section, rows }) => (
            <PermissionGrid
              key={Sections.scopePrefix(section)}
              title={sectionTitle(section, multipleContexts)}
              chip={sectionChip(section)}
              section={section}
              rows={rows}
              onToggleItem={(resource, itemId) => {
                toggleCell(section, resource, itemId)
              }}
              wildcardNote={
                rows.some((row) => row.isWildcard)
                  ? 'Covers all current and future record types.'
                  : undefined
              }
            />
          ))}
          {viewToggle}
        </div>
      )}

      {exclusions.length > 0 ? (
        <div className={cn(styles['section'], styles['section--sunken'])}>
          <p className={styles['eyebrow']}>It won&apos;t be able to</p>
          {exclusions.map((exclusion) => (
            <ExclusionRow
              key={exclusion.key}
              label={exclusion.label}
              allowed={false}
              allowable={false}
              onToggle={() => {
                // Informational only (`spec.md §8`) — never widened here.
              }}
            />
          ))}
        </div>
      ) : null}

      {flags.length > 0 || request.requested.unknown.length > 0 ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>Sign-in &amp; app basics</p>
          {flags.map((flag) => (
            <FlagToggleRow
              key={flag.name}
              label={flag.plainExplanation()}
              code={flag.serialize()}
              checked={draft.known.some(Equal.equals(flag))}
              onChange={() => {
                setDraft((previous) => GrantDraft.toggleFlag(previous, flag.name))
              }}
            />
          ))}
          {request.requested.unknown.map((scope) => (
            <FlagToggleRow
              key={scope.serialize()}
              label={scope.serialize()}
              code={scope.serialize()}
              checked={draft.unknown.some(Equal.equals(scope))}
              onChange={() => {
                toggleUnknown(scope)
              }}
            />
          ))}
        </div>
      ) : null}

      <div className={styles['footer']}>
        {errorMessage !== null ? (
          <p className={cn(pageLayoutStyles['error'], styles['error'], 'text-body-3')} role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className={styles['buttons']}>
          <button
            type="button"
            className={cn('button-2 outline accent-red', styles['deny'])}
            disabled={submitting}
            onClick={handleDecline}
          >
            Deny
          </button>
          <button
            type="button"
            className={cn('button-2 filled', styles['allow'])}
            disabled={serialized.length === 0 || submitting}
            onClick={handleApprove}
          >
            Allow access
          </button>
        </div>
      </div>
    </section>
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
