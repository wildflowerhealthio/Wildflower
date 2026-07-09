/**
 * The Wildflower scope picker — the whole grant-editing surface over one
 * {@link ScopeRequest.ScopeRequest}: the plain-language statement list and the
 * resource×interaction detail grid (toggleable), the curated §8 exclusions, and the
 * sign-in flag toggles. Controlled: every edit lands in
 * {@link ScopePickerProps.onDraftChange}; the composing surface (OAuth consent, device
 * confirmation, app-config editing, …) owns the draft, its persistence, and the card
 * chrome around this.
 */
import { Equal } from 'effect'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { GrantDraft, Rows, Scope, ResourceSection, ScopeRequest } from 'scopes-core'

import { AddRuleButton, type AddRuleOption } from '../atoms/add-rule-button.tsx'
import { ExclusionRow } from '../atoms/exclusion-row.tsx'
import { FlagToggleRow } from '../atoms/flag-toggle-row.tsx'
import { PermissionPicker } from '../molecules/permission-picker.tsx'
import { pickerItemsFor } from '../molecules/picker-items.ts'
import { SubjectSelector, type SubjectContext } from '../molecules/subject-selector.tsx'
import { exclusionStatementsFrom } from './exclusion-statements.ts'
import { PermissionGrid } from './permission-grid.tsx'
import { PermissionStatement } from './permission-statement.tsx'
import styles from './scope-picker.module.css'

/**
 * How the picker clamps edits. `clamped` (default) is the app-consent envelope — the grant may
 * only be *narrowed* within `request.requested`. `expandable` is the device-authorization
 * flow — the approver may also *add* scopes beyond what was requested, up to the client's
 * allowed set (`request.available`), with the "+ Add rule" affordance and the one-patient /
 * all-patients subject selector.
 */
type ScopePickerMode = 'clamped' | 'expandable'

interface ScopePickerProps {
  /** The sentence subject of the first plain statement ("<subjectName> can …"). */
  readonly subjectName: string
  /** The request envelope the draft edits against. */
  readonly request: ScopeRequest.ScopeRequest
  /** The live draft — controlled; every edit lands in {@link ScopePickerProps.onDraftChange}. */
  readonly draft: GrantDraft.GrantDraft
  readonly onDraftChange: (draft: GrantDraft.GrantDraft) => void
  /** The clamp mode — defaults to `clamped` (app consent); `expandable` for device auth. */
  readonly mode?: ScopePickerMode
}

/** Which projection is showing — plain-language statements or the resource×interaction grid. */
type View = 'plain' | 'detail'

/** Whether a section addresses the launch patient's own records (FHIR, patient context). */
const isPatientSection = (section: ResourceSection.Any): boolean =>
  Equal.equals(section.context, Scope.Contexts.Fhir.patient)

/** The FHIR heading for a context level (`spec.md §8` — `system` always names its all-patients reach). */
const fhirTitle = (level: Scope.Contexts.Fhir.Level, multipleContexts: boolean): string => {
  if (level === 'system') return 'Health records — all patients'
  if (!multipleContexts) return 'Health records'
  return level === 'patient' ? 'Health records — this patient' : 'Health records — your access'
}

/** Section heading (serif). */
const sectionTitle = (section: ResourceSection.Any, multipleContexts: boolean): string =>
  section.kind === 'wildflower'
    ? 'Wildflower admin'
    : fhirTitle(section.context.context, multipleContexts)

/** Section tag chip (`FHIR` / `Admin`). */
const sectionChip = (section: ResourceSection.Any): string =>
  section.kind === 'wildflower' ? 'Admin' : 'FHIR'

/**
 * The lead-in phrase for the running statement list: the subject carries the
 * first sentence, "It can also" the second, and later rows fall back to a
 * minimal "…and" so a long request doesn't chant the same phrase.
 */
const subjectPhraseFor = (subjectName: string, index: number): string => {
  if (index === 0) return `${subjectName} can`
  if (index === 1) return 'It can also'
  return '…and'
}

/** Whether the `available` envelope grants at the FHIR `system` context (⇒ patient too). */
const availableCoversSystem = (request: ScopeRequest.ScopeRequest): boolean =>
  Scope.MultiScope.fhirScopes(ScopeRequest.availableOf(request)).some((scope) =>
    scope.context.covers(Scope.Contexts.Fhir.system)
  )

/** The FHIR context a subject choice maps to (`spec.md §9`). */
const contextFor = (subject: SubjectContext): Scope.Contexts.Fhir =>
  subject === 'system' ? Scope.Contexts.Fhir.system : Scope.Contexts.Fhir.patient

/** The subject the picker lands on: the requested FHIR context if any, else one patient (`spec.md §9`). */
const initialSubject = (request: ScopeRequest.ScopeRequest): SubjectContext =>
  Scope.MultiScope.fhirScopes(request.requested).some((scope) =>
    scope.hasContext(Scope.Contexts.Fhir.system)
  )
    ? 'system'
    : 'patient'

/**
 * The "+ Add rule" options for a section: the catalog resources not already `shown` (nor the
 * `*` wildcard row). Clamped by the cell-level `available` check, so an offered resource with no
 * grantable interaction simply renders every cell disabled.
 */
const addOptionsFor = (
  section: ResourceSection.Any,
  shown: ReadonlySet<string>
): readonly AddRuleOption[] => {
  const catalog =
    section.kind === 'wildflower'
      ? Scope.ResourceType.Wildflower.catalog
      : Scope.ResourceType.Fhir.catalog
  return catalog.flatMap((name) => {
    if (shown.has(name)) return []
    const label = section.configuration.resourceClass.parse(name)?.singularLabel() ?? name
    return [{ name, label }]
  })
}

const ScopePicker = ({
  subjectName,
  request,
  draft,
  onDraftChange,
  mode = 'clamped',
}: ScopePickerProps): JSX.Element => {
  const isExpandable = mode === 'expandable'

  const [view, setView] = useState<View>(isExpandable ? 'detail' : 'plain')
  const [openRow, setOpenRow] = useState<string | null>(null)
  // The FHIR context new rules target — driven by the one-patient / all-patients selector.
  const [subject, setSubject] = useState<SubjectContext>(() => initialSubject(request))
  // Resources the user added via "+ Add rule" but hasn't toggled yet, keyed by section prefix.
  // Held here (never as empty-permission draft scopes) so `GrantDraft.hasScopes` stays honest.
  const [extra, setExtra] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())

  // The subject selector is only meaningful when the envelope can grant at both contexts.
  const showSubjectSelector = isExpandable && availableCoversSystem(request)
  const activeContext = contextFor(subject)

  const sections = useMemo(
    () =>
      isExpandable
        ? ResourceSection.listForDraft(request, draft, extra, activeContext)
        : ResourceSection.listFromRequest(request),
    [isExpandable, request, draft, extra, activeContext]
  )
  // Whether the shown FHIR sections span more than one context level — the section titles
  // then disambiguate ("this patient" / "your access").
  const multipleContexts = useMemo(() => {
    const fhirContexts = sections
      .filter((section) => section.kind !== 'wildflower')
      .map((section) => section.context.serialize())
    return new Set(fhirContexts).size > 1
  }, [sections])
  const flags = useMemo(
    () => Scope.Known.inCanonicalOrder(ScopeRequest.availableOf(request).known),
    [request]
  )
  const exclusions = useMemo(() => exclusionStatementsFrom(request), [request])

  const grids = useMemo(
    () =>
      sections.map((section) => ({
        section,
        rows: Rows.build(section, draft, request, { includeWildcard: true }),
      })),
    [sections, draft, request]
  )

  const addRule = (section: ResourceSection.Any, name: string): void => {
    const key = ResourceSection.scopePrefix(section)
    setExtra((previous) => {
      const next = new Map(previous)
      next.set(key, [...(next.get(key) ?? []), name])
      return next
    })
  }

  const toggleCell = (
    section: ResourceSection.Any,
    resource: Scope.MultiScope.ResourceOf<Scope.MultiScope.Kind>,
    itemId: Scope.MultiScope.InteractionOf<Scope.MultiScope.Kind>
  ): void => {
    onDraftChange(
      GrantDraft.toggleItem(draft, section.configuration, section.context, resource, itemId)
    )
  }

  const toggleUnknown = (scope: Scope.Unknown): void => {
    onDraftChange({
      ...draft,
      unknown: draft.unknown.some(Equal.equals(scope))
        ? draft.unknown.filter((unknown) => !Equal.equals(unknown, scope))
        : [...draft.unknown, scope],
    })
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
    <>
      {showSubjectSelector ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>Whose records</p>
          <SubjectSelector value={subject} onChange={setSubject} />
        </div>
      ) : null}

      {view === 'plain' ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>What it&apos;s asking for</p>
          {grids.map(({ section, rows }) =>
            rows.map((row) => {
              const rowKey = `${ResourceSection.scopePrefix(section)}/${row.resource.serialize()}`
              // Plural in the running sentence ("Read your Conditions") — the
              // grid keeps the singular row labels.
              const label = row.resource.pluralLabel()
              const items = pickerItemsFor(section.configuration, row)
              const grantedNames = items
                .filter((item) => item.state === 'on' || item.state === 'locked')
                .map((item) => item.name)
              const subjectPhrase = subjectPhraseFor(subjectName, statementIndex)
              statementIndex += 1
              return (
                <PermissionStatement
                  key={rowKey}
                  subjectPhrase={subjectPhrase}
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
        </div>
      ) : (
        <div className={styles['section']}>
          {grids.map((grid) => (
            <div key={ResourceSection.scopePrefix(grid.section)}>
              <PermissionGrid
                title={sectionTitle(grid.section, multipleContexts)}
                chip={sectionChip(grid.section)}
                section={grid.section}
                rows={grid.rows}
                onToggleItem={(resource, itemId) => {
                  toggleCell(grid.section, resource, itemId)
                }}
                wildcardNote={
                  grid.rows.some((row) => row.isWildcard)
                    ? 'Covers all current and future record types.'
                    : undefined
                }
              />
              {isExpandable ? (
                <AddRuleButton
                  options={addOptionsFor(
                    grid.section,
                    new Set(grid.rows.map((row) => row.resource.serialize()))
                  )}
                  onAdd={(name) => {
                    addRule(grid.section, name)
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* The plain ⇄ detail toggle sits between the exclusions and the flag
          rows, so "see exactly what's granted" leads into the sign-in basics. */}
      <div className={styles['toggle-bar']}>{viewToggle}</div>

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

      {flags.length > 0 || ScopeRequest.availableOf(request).unknown.length > 0 ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>Sign-in &amp; app basics</p>
          {flags.map((flag) => (
            <FlagToggleRow
              key={flag.name}
              label={flag.plainExplanation()}
              code={flag.serialize()}
              checked={draft.known.some(Equal.equals(flag))}
              onChange={() => {
                onDraftChange(GrantDraft.toggleFlag(draft, flag.name))
              }}
            />
          ))}
          {ScopeRequest.availableOf(request).unknown.map((scope) => (
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
    </>
  )
}

export { ScopePicker, type ScopePickerProps, type ScopePickerMode }
