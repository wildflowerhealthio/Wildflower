import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, pageLayoutStyles, RadioGroup } from 'react-tundraish'
import { GrantDraft, Scope } from 'scopes-core'
import type { GrantDraft as GrantDraftModel, ScopeRequest } from 'scopes-core'
import {
  buildGrid,
  ExclusionRow,
  FlagToggleRow,
  PermissionGrid,
  PermissionPicker,
  PermissionStatement,
  type Grid,
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
import type { Consent } from './types.ts'
import { usePatientOptions } from './use-patient-options.ts'
import groups from '../../styles/consent-groups.module.css'
import pageLayout from '../../styles/page-layout.module.css'

interface OAuthConsentFormProps {
  readonly consent: Consent
  readonly onDone: (result: OAuthConsentResult) => void
}

/** Which projection the form is showing — plain-language statements or the resource×interaction grid. */
type View = 'plain' | 'detail'

/** Project one section's grid over the current draft ({@link buildGrid} per section variant). */
const buildSectionGrid = (
  section: ConsentSection,
  draft: GrantDraftModel.GrantDraft,
  request: ScopeRequest.ScopeRequest
): Grid => buildGrid(section.section, draft, request, { includeWildcard: true })

/**
 * Apply one cell toggle to the draft. The grid hands back plain strings; each is resolved to
 * the section variant's typed resource / interaction before delegating to
 * {@link GrantDraft.toggleItem} — the resolution stays within the variant's own partition
 * (no cast). A string that doesn't resolve (never happens for a rendered row) leaves the
 * draft unchanged.
 */
const applyToggle = <K extends Scope.MultiScope.Kind>(
  section: {
    readonly configuration: Scope.MultiScope.ConfigurationFor<K>
    readonly context: Scope.MultiScope.ContextOf<K>
  },
  draft: GrantDraftModel.GrantDraft,
  resourceString: string,
  itemIdString: string
): GrantDraftModel.GrantDraft => {
  const { configuration, context } = section
  const resource = configuration.resourceClass.parse(resourceString)
  if (resource === null) return draft
  const item = configuration.permissionClass.empty.items.find((i) => i.id === itemIdString)
  if (item === undefined) return draft
  return GrantDraft.toggleItem(draft, configuration, context, resource, item.id)
}

/** Apply a cell toggle for a section of any variant (delegates to {@link applyToggle}). */
const applyToggleForSection = (
  section: ConsentSection,
  draft: GrantDraftModel.GrantDraft,
  resourceString: string,
  itemIdString: string
): GrantDraftModel.GrantDraft => applyToggle(section.section, draft, resourceString, itemIdString)

/** Whether a section addresses the launch patient's own records (FHIR, patient context). */
const isPatientSection = (section: ConsentSection): boolean =>
  section.kind !== 'wildflower' && section.section.context.serialize() === 'patient'

const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
  const request = useMemo(() => consentScopeRequest(consent), [consent])
  const sections = useMemo(() => consentSections(request), [request])
  const flags = useMemo(() => consentFlags(request), [request])
  const exclusions = useMemo(() => consentExclusions(request), [request])

  // The launch-patient picker matters when a FHIR patient-context scope or `launch/patient`
  // is requested.
  const hasPatientScope = useMemo(
    () =>
      [...request.requested.fhirV1, ...request.requested.fhirV2].some((scope) =>
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
        grid: buildSectionGrid(section, draft, request),
      })),
    [sections, draft, request]
  )

  const serialized = useMemo(() => GrantDraft.serializeAll(draft), [draft])

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  const errorMessage = resultError ?? mutationError

  const toggleCell = (section: ConsentSection, resource: string, itemId: string): void => {
    setDraft((previous) => applyToggleForSection(section, previous, resource, itemId))
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

  const flagRows = (
    <div className={groups['group']}>
      <p className={cn(groups['group-title'], 'text-body-2')}>Sign-in &amp; app basics</p>
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
  )

  const exclusionRows =
    exclusions.length === 0 ? null : (
      <div className={groups['group']}>
        <p className={cn(groups['group-title'], 'text-body-2')}>It won&apos;t be able to</p>
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
    )

  // A single running index across all sections drives the "It can also" lead-in after the
  // first statement.
  let statementIndex = 0

  return (
    <>
      <Field label="Application">
        <span className="text-body-2">{consent.clientId}</span>
      </Field>

      {view === 'plain' ? (
        <div className={groups['statements']}>
          {grids.map(({ section, grid }) =>
            grid.rows.map((row) => {
              const rowKey = `${section.kind}/${section.section.context.serialize()}/${row.resource}`
              const grantedNames = row.items
                .filter((item) => item.state === 'on' || item.state === 'locked')
                .map((item) => item.name)
              const subject = statementIndex === 0 ? `${consent.clientId} can` : 'It can also'
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
                    ariaLabel={`Permissions on ${row.label}`}
                    onToggle={(itemId) => {
                      toggleCell(section, row.resource, itemId)
                    }}
                  />
                </PermissionStatement>
              )
            })
          )}
        </div>
      ) : (
        <div className={groups['detail']}>
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
                grid.rows.some((row) => row.resource === '*')
                  ? 'Covers all current and future record types.'
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {flags.flags.length > 0 || flags.unknown.length > 0 ? flagRows : null}
      {exclusionRows}

      <button
        type="button"
        className={cn('button-1 outline', groups['view-toggle'])}
        onClick={() => {
          setView((current) => (current === 'plain' ? 'detail' : 'plain'))
        }}
      >
        {view === 'plain' ? 'See exactly what’s granted' : 'Back to summary'}
      </button>

      {hasPatientScope && patients.length > 0 ? (
        <RadioGroup
          legend="Patient Context"
          name="patient"
          value={draft.patient ?? ''}
          onChange={(value) => {
            setDraft((previous) => ({ ...previous, patient: value === '' ? null : value }))
          }}
          options={[
            { value: '', label: 'No patient context' },
            ...patients.map((patient) => ({
              value: patient.id,
              label: (
                <>
                  {patient.displayName} <code>{patient.id}</code>
                </>
              ),
            })),
          ]}
        />
      ) : null}

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className={pageLayout['buttons']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={serialized.length === 0 || submitting}
          onClick={handleApprove}
        >
          Approve
        </button>
        <button
          type="button"
          className="button-2 outline"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
      </div>
    </>
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
