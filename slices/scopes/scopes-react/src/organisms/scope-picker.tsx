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
import { Chip } from 'react-tundraish'
import { GrantDraft, Rows, Scope, ResourceSection, ScopeRequest } from 'scopes-core'

import { AddRuleButton, type AddRuleOption } from '../atoms/add-rule-button.tsx'
import { ExclusionRow } from '../atoms/exclusion-row.tsx'
import { FlagToggleRow } from '../atoms/flag-toggle-row.tsx'
import { PermissionPicker } from '../molecules/permission-picker.tsx'
import { pickerItemsFor } from '../molecules/picker-items.ts'
import {
  SubjectSelector,
  type PatientOption,
  type SubjectContext,
} from '../molecules/subject-selector.tsx'
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

/**
 * The sentence voice of the plain statements. `can` states standing ability ("<subject> can
 * Read your …") — the app-consent/editing surfaces. `asking` frames a permission ask
 * ("<subject> is asking to Read …") — the answering surface, where the subject is requesting
 * access it doesn't have yet. `requesting` is first person ("You're requesting permission to
 * Read …") — the device-setup surface, where the user composes their own request. Only `can`
 * carries the "your" possessive; in the other voices the records aren't necessarily the
 * reader's own.
 */
type ScopePickerPhrasing = 'can' | 'asking' | 'requesting'

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
  /** The statement voice — defaults to `can`; `asking` for the answering surface. */
  readonly phrasing?: ScopePickerPhrasing
  /**
   * The account's patients, when the surface can name one (the answering side). Present ⇒
   * the subject selector's "Just one patient" choice carries a which-patient pill, landing
   * in {@link GrantDraft.GrantDraft.patient} (a UI concern — never serialized into scopes).
   */
  readonly patients?: readonly PatientOption[]
  /**
   * Forces the FHIR subject that new rules target, hiding the one-patient / all-patients
   * selector so the picker can't switch contexts. Device-auth surfaces pass `'system'` so a
   * device grant targets all patients only — the FHIR server's `patient/` support is too weak
   * to offer the one-patient subject there. Omitted ⇒ the user picks freely via the selector
   * (the normal expandable behaviour); this prop scopes the restriction to the caller, leaving
   * every other picker untouched.
   */
  readonly forcedSubject?: SubjectContext
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
 * The lead-in phrase for one section's running statement list: the subject carries the
 * first sentence, a follow-on phrase the second, and later rows fall back to a
 * minimal "…and" so a long section doesn't chant the same phrase. The `asking`
 * voice frames a permission ask rather than a standing ability.
 */
const subjectPhraseFor = (
  subjectName: string,
  index: number,
  phrasing: ScopePickerPhrasing
): string => {
  if (index >= 2) return '…and'
  if (phrasing === 'asking') {
    return index === 0 ? `${subjectName} is asking to` : 'It’s also asking to'
  }
  if (phrasing === 'requesting') {
    // First person — the reader is composing their own request; the device
    // name doesn't carry the sentence.
    return index === 0 ? 'You’re requesting permission to' : '…and to'
  }
  return index === 0 ? `${subjectName} can` : 'It can also'
}

/** Whether the `available` envelope grants at the FHIR `system` context (⇒ patient too). */
const availableCoversSystem = (request: ScopeRequest.ScopeRequest): boolean =>
  Scope.MultiScope.fhirScopes(ScopeRequest.availableOf(request)).some((scope) =>
    scope.context.covers(Scope.Contexts.Fhir.system)
  )

/** The FHIR context a subject choice maps to (`spec.md §9`). */
const contextFor = (subject: SubjectContext): Scope.Contexts.Fhir =>
  subject === 'system' ? Scope.Contexts.Fhir.system : Scope.Contexts.Fhir.patient

/**
 * The subject the picker lands on: `system` when the request *or the seeded draft* already
 * reaches all patients (a preset-seeded draft carries `system/` scopes the request may not),
 * else one patient (`spec.md §9`).
 */
const initialSubject = (
  request: ScopeRequest.ScopeRequest,
  draft: GrantDraft.GrantDraft
): SubjectContext =>
  [...Scope.MultiScope.fhirScopes(request.requested), ...Scope.MultiScope.fhirScopes(draft)].some(
    (scope) => scope.hasContext(Scope.Contexts.Fhir.system)
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
  phrasing = 'can',
  patients,
  forcedSubject,
}: ScopePickerProps): JSX.Element => {
  const isExpandable = mode === 'expandable'

  const [view, setView] = useState<View>('plain')
  const [openRow, setOpenRow] = useState<string | null>(null)
  // The FHIR context new rules target — a forced subject (device auth pins all-patients) when
  // the caller supplies one, otherwise the one-patient / all-patients selector's live choice.
  const [subject, setSubject] = useState<SubjectContext>(
    () => forcedSubject ?? initialSubject(request, draft)
  )
  // Resources the user added via "+ Add rule" but hasn't toggled yet, keyed by section prefix.
  // Held here (never as empty-permission draft scopes) so `GrantDraft.hasScopes` stays honest.
  const [extra, setExtra] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())

  // The subject selector is only meaningful when the caller hasn't forced a subject and the
  // envelope can grant at both contexts.
  const showSubjectSelector =
    isExpandable && forcedSubject === undefined && availableCoversSystem(request)
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
  // Derived from the live draft, so building the grant up retires covered statements.
  const exclusions = useMemo(() => exclusionStatementsFrom(draft), [draft])

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

  const changeSubject = (next: SubjectContext): void => {
    if (next === subject) return
    setSubject(next)
    const from = contextFor(subject)
    const to = contextFor(next)
    // The switch moves the WHOLE in-progress selection between contexts —
    // mixing one-patient and all-patients sections is more confusing than
    // helpful. All-patients reach has no single patient, so the UI-only
    // choice clears with it.
    const retargeted = GrantDraft.retargetFhirContext(draft, from, to)
    onDraftChange(next === 'system' ? { ...retargeted, patient: null } : retargeted)
    // Un-toggled "+ Add rule" rows follow their section across the switch.
    setExtra((previous) => {
      const migrated = new Map(previous)
      for (const kind of ['fhirV1', 'fhirV2'] as const) {
        const fromKey = ResourceSection.prefixFor(kind, from)
        const toKey = ResourceSection.prefixFor(kind, to)
        const moved = migrated.get(fromKey)
        if (moved === undefined) continue
        migrated.delete(fromKey)
        migrated.set(toKey, [...(migrated.get(toKey) ?? []), ...moved])
      }
      return migrated
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
          <SubjectSelector
            value={subject}
            onChange={changeSubject}
            patients={patients}
            patientId={draft.patient}
            onPatientChange={(patientId) => {
              onDraftChange({ ...draft, patient: patientId })
            }}
          />
        </div>
      ) : null}

      {view === 'plain' ? (
        <div className={styles['section']}>
          <p className={styles['eyebrow']}>What it&apos;s asking for</p>
          {grids.map(({ section, rows }) => (
            <div key={ResourceSection.scopePrefix(section)} className={styles['plain-section']}>
              {/* The same headings as the detail grid, so a wildcard statement always
                  reads against its record set ("Health records — this patient", …). */}
              <header className={styles['plain-header']}>
                <h3 className={styles['plain-title']}>{sectionTitle(section, multipleContexts)}</h3>
                <Chip>{sectionChip(section)}</Chip>
              </header>
              {rows.map((row, rowIndex) => {
                const rowKey = `${ResourceSection.scopePrefix(section)}/${row.resource.serialize()}`
                // Plural in the running sentence ("Read your Conditions") — the
                // grid keeps the singular row labels.
                const label = row.resource.pluralLabel()
                const items = pickerItemsFor(section.configuration, row)
                const grantedNames = items
                  .filter((item) => item.state === 'on' || item.state === 'locked')
                  .map((item) => item.name)
                return (
                  <PermissionStatement
                    key={rowKey}
                    subjectPhrase={subjectPhraseFor(subjectName, rowIndex, phrasing)}
                    // The possessive only fits the `can` voice — in an ask, the records
                    // aren't necessarily the approver's own.
                    connector={phrasing === 'can' && isPatientSection(section) ? 'your' : undefined}
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
              })}
              {isExpandable ? (
                <AddRuleButton
                  options={addOptionsFor(
                    section,
                    new Set(rows.map((row) => row.resource.serialize()))
                  )}
                  onAdd={(name) => {
                    addRule(section, name)
                  }}
                />
              ) : null}
            </div>
          ))}
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

export { ScopePicker, type ScopePickerProps, type ScopePickerMode, type ScopePickerPhrasing }
