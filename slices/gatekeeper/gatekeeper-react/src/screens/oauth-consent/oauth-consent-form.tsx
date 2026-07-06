import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles, StatusBadge } from 'react-tundraish'
import { GrantDraft, Scope } from 'scopes-core'
import type { GrantDraft as GrantDraftModel } from 'scopes-core'
import {
  ExclusionRow,
  FlagToggleRow,
  PermissionGrid,
  PermissionPicker,
  PermissionStatement,
  Grid,
} from 'scopes-react'

import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { OAuthConsentResult } from '../../queries/index.ts'
import {
  consentExclusions,
  consentFlags,
  consentScopeRequest,
  consentSections,
} from './consent-sections.ts'
import type { ConsentSection } from './consent-sections.ts'
import { PatientPillPicker } from './patient-pill-picker.tsx'
import type { Consent } from './types.ts'
import { usePatientOptions } from './use-patient-options.ts'
import styles from '../../styles/consent-card.module.css'

interface OAuthConsentFormProps {
  readonly consent: Consent
  readonly onDone: (result: OAuthConsentResult) => void
}

/** Which projection the form is showing — plain-language statements or the resource×interaction grid. */
type View = 'plain' | 'detail'

/** Whether a section addresses the launch patient's own records (FHIR, patient context). */
const isPatientSection = (section: ConsentSection): boolean =>
  section.kind !== 'wildflower' && section.section.context.serialize() === 'patient'

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
  const request = useMemo(() => consentScopeRequest(consent), [consent])
  const sections = useMemo(() => consentSections(request), [request])
  const flags = useMemo(() => consentFlags(request), [request])
  const exclusions = useMemo(() => consentExclusions(request), [request])

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
        grid: Grid.make(section.section, draft, request, { includeWildcard: true }),
      })),
    [sections, draft, request]
  )

  const serialized = useMemo(() => GrantDraft.serializeAll(draft), [draft])

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  const errorMessage = resultError ?? mutationError

  const toggleCell = (
    section: ConsentSection,
    resource: Scope.MultiScope.ResourceOf<Scope.MultiScope.Kind>,
    itemId: Scope.MultiScope.InteractionOf<Scope.MultiScope.Kind>
  ): void => {
    setDraft((previous) =>
      GrantDraft.toggleItem(
        previous,
        section.section.configuration,
        section.section.context,
        resource,
        itemId
      )
    )
  }

  const toggleUnknown = (raw: string): void => {
    setDraft((previous) => ({
      ...previous,
      unknown: previous.unknown.some((scope) => scope.serialize() === raw)
        ? previous.unknown.filter((scope) => scope.serialize() !== raw)
        : [...previous.unknown, new Scope.Unknown(raw)],
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
          {grids.map(({ section, grid }) =>
            grid.rows.map((row) => {
              const rowKey = `${section.kind}/${section.section.context.serialize()}/${row.resource.serialize()}`
              const grantedNames = row.items
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
                  resourceLabel={row.label}
                  open={openRow === rowKey}
                  onToggleOpen={() => {
                    setOpenRow((current) => (current === rowKey ? null : rowKey))
                  }}
                >
                  <PermissionPicker
                    items={row.items}
                    variant="plain"
                    ariaLabel={`Permissions on ${row.label}`}
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
          {grids.map(({ section, grid }) => (
            <PermissionGrid
              key={section.key}
              title={section.title}
              chip={section.chip}
              grid={grid}
              onToggleItem={(resource, itemId) => {
                toggleCell(section, resource, itemId)
              }}
              wildcardNote={
                grid.rows.some((row) => row.resource.serialize() === '*')
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

      {flags.flags.length > 0 || flags.unknown.length > 0 ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>Sign-in &amp; app basics</p>
          {flags.flags.map((name) => {
            const flag = new Scope.Known(name)
            return (
              <FlagToggleRow
                key={name}
                label={flag.plainExplanation()}
                code={flag.serialize()}
                checked={draft.known.some((known) => known.name === name)}
                onChange={() => {
                  setDraft((previous) => GrantDraft.toggleFlag(previous, name))
                }}
              />
            )
          })}
          {flags.unknown.map((raw) => (
            <FlagToggleRow
              key={raw}
              label={raw}
              code={raw}
              checked={draft.unknown.some((scope) => scope.serialize() === raw)}
              onChange={() => {
                toggleUnknown(raw)
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
