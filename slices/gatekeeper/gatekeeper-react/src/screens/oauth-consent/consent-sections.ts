/**
 * The DOM-free consent view-model: derives the {@link Section} list, flag list, and
 * curated exclusions the OAuth consent form renders, straight off a {@link Consent}'s
 * requested scopes. All-optional by design — the derived {@link ScopeRequest.ScopeRequest}
 * carries an empty `required`, so nothing locks on; the form seeds every requested scope as
 * granted (via {@link GrantDraft.fromScopes}) and lets the user prune.
 *
 * The section derivation groups the requested resource scopes by (variant kind, context):
 * one FHIR section per context level present (patient / user / system), one Wildflower
 * admin section. Each section's catalog is exactly the resource names the app asked for at
 * that (kind, context) — never the whole vocabulary (`spec.md §8`: no auto-complement). The
 * `*` wildcard row a section may show is injected by {@link buildGrid}/`Rows.build`, so the
 * wildcard resource is excluded from the catalog here.
 */

import { Grant, Scope } from 'scopes-core'
import type { ScopeRequest } from 'scopes-core'
import type { Section } from 'scopes-react'

import type { Consent } from './types.ts'

/** One derived consent section, correlated to its variant literal so {@link buildGrid} stays generic. */
type ConsentSectionOf<K extends Scope.MultiScope.Kind> = {
  readonly kind: K
  /** Stable render key (`${kind}/${contextSerialized}`). */
  readonly key: string
  /** Section heading (serif). */
  readonly title: string
  /** Section tag chip (`FHIR` / `Admin`). */
  readonly chip: string
  readonly section: Section<K>
}

/** A derived consent section over any resource variant — a discriminated union on {@link ConsentSectionOf.kind}. */
type ConsentSection =
  | ConsentSectionOf<'fhirV1'>
  | ConsentSectionOf<'fhirV2'>
  | ConsentSectionOf<'wildflower'>

/** The requested known flags (in canonical order) plus the raw unknown scopes, for the flag group. */
type ConsentFlags = {
  readonly flags: readonly Scope.Known.Name[]
  readonly unknown: readonly string[]
}

/** One curated "It won't be able to…" line (`spec.md §8`) — informational, never an auto-complement. */
type ConsentExclusion = {
  readonly key: string
  readonly label: string
}

/** The FHIR context levels the picker lists, in patient → user → system order. */
const fhirContextsInOrder: readonly Scope.Contexts.Fhir[] = [
  Scope.Contexts.Fhir.patient,
  Scope.Contexts.Fhir.user,
  Scope.Contexts.Fhir.system,
]

/**
 * The all-optional {@link ScopeRequest.ScopeRequest} a consent decision edits against: the
 * app's requested scopes as the envelope, with an empty `required` — no control ever locks
 * on, every requested control is prunable.
 */
const consentScopeRequest = (consent: Consent): ScopeRequest.ScopeRequest => ({
  requested: Grant.parse(consent.scopes),
  required: Grant.make([]),
})

/**
 * Order resource names by their position in `order`, appending any name not in `order` in
 * first-seen order — the row order a section's catalog renders in. De-duplicates.
 */
const orderedCatalog = (names: readonly string[], order: readonly string[]): string[] => {
  const seen = new Set(names)
  const listed = order.filter((name) => seen.has(name))
  const unlisted: string[] = []
  const known = new Set(order)
  for (const name of names) {
    if (!known.has(name) && !unlisted.includes(name)) unlisted.push(name)
  }
  return [...listed, ...unlisted]
}

/** The FHIR heading for a context level (`spec.md §8` — `system` always names its all-patients reach). */
const fhirTitle = (level: Scope.Contexts.Fhir.Level, multipleContexts: boolean): string => {
  if (level === 'system') return 'Health records — all patients'
  if (!multipleContexts) return 'Health records'
  return level === 'patient' ? 'Health records — this patient' : 'Health records — your access'
}

/** Every FHIR section for one variant kind — one per context level present in the request. */
const fhirSectionsFor = <K extends 'fhirV1' | 'fhirV2'>(
  request: ScopeRequest.ScopeRequest,
  kind: K,
  configuration: Scope.MultiScope.ConfigurationFor<K>,
  multipleContexts: boolean
): ConsentSectionOf<K>[] => {
  const partition = Scope.MultiScope.partition(request.requested, kind)
  const sections: ConsentSectionOf<K>[] = []
  for (const context of fhirContextsInOrder) {
    const here = partition.filter((scope) => scope.hasContext(context))
    if (here.length === 0) continue
    const names = here.map((scope) => scope.resource.serialize()).filter((name) => name !== '*')
    sections.push({
      kind,
      key: `${kind}/${context.serialize()}`,
      title: fhirTitle(context.context, multipleContexts),
      chip: 'FHIR',
      section: {
        configuration,
        context,
        catalog: orderedCatalog(names, Scope.ResourceType.Fhir.catalog),
      },
    })
  }
  return sections
}

/**
 * The grid sections for a request, one per (variant kind, context) with a non-empty
 * requested partition — FHIR v2 then v1 (each patient → user → system), then Wildflower
 * admin. Each section's catalog is exactly the requested resource names at that (kind,
 * context), wildcard excluded.
 */
const consentSections = (request: ScopeRequest.ScopeRequest): ConsentSection[] => {
  const fhirScopes = [...request.requested.fhirV1, ...request.requested.fhirV2]
  const multipleContexts = new Set(fhirScopes.map((scope) => scope.context.serialize())).size > 1

  const sections: ConsentSection[] = [
    ...fhirSectionsFor(request, 'fhirV2', Scope.FhirV2.configuration, multipleContexts),
    ...fhirSectionsFor(request, 'fhirV1', Scope.FhirV1.configuration, multipleContexts),
  ]

  const wildflower = Scope.MultiScope.partition(request.requested, 'wildflower')
  if (wildflower.length > 0) {
    const names = wildflower
      .map((scope) => scope.resource.serialize())
      .filter((name) => name !== '*')
    sections.push({
      kind: 'wildflower',
      key: 'wildflower/wildflower',
      title: 'Wildflower admin',
      chip: 'Admin',
      section: {
        configuration: Scope.Wildflower.configuration,
        context: new Scope.Contexts.Wildflower(),
        catalog: orderedCatalog(names, Scope.ResourceType.Wildflower.catalog),
      },
    })
  }

  return sections
}

/** The requested known flags in canonical order, plus the raw unknown scopes to render as flag rows. */
const consentFlags = (request: ScopeRequest.ScopeRequest): ConsentFlags => {
  const requested = new Set(request.requested.known.map((known) => known.name))
  return {
    flags: Scope.Known.Name.all.filter((name) => requested.has(name)),
    unknown: request.requested.unknown.map((unknown) => unknown.serialize()),
  }
}

/**
 * The curated informational exclusions (`spec.md §8`) — each line is shown *unless* the
 * request already covers it: broad record types, admin surface, background access, and
 * other-patient reach. Never the auto-computed complement of the grant.
 */
const consentExclusions = (request: ScopeRequest.ScopeRequest): ConsentExclusion[] => {
  const fhirScopes = [...request.requested.fhirV1, ...request.requested.fhirV2]
  const hasFhirWildcard = fhirScopes.some((scope) => scope.resource.serialize() === '*')
  const hasWildflower = request.requested.wildflower.length > 0
  const hasOfflineAccess = request.requested.known.some((known) => known.name === 'offline_access')
  const hasSystemFhir = fhirScopes.some((scope) => scope.hasContext(Scope.Contexts.Fhir.system))

  const exclusions: ConsentExclusion[] = []
  if (!hasFhirWildcard) {
    exclusions.push({ key: 'other-record-types', label: 'Other health record types' })
  }
  if (!hasWildflower) {
    exclusions.push({ key: 'admin', label: 'Admin settings & connected apps' })
  }
  if (!hasOfflineAccess) {
    exclusions.push({ key: 'offline', label: 'Stay connected in the background' })
  }
  if (!hasSystemFhir) {
    exclusions.push({ key: 'other-patients', label: 'Records for other patients' })
  }
  return exclusions
}

export {
  type ConsentSection,
  type ConsentSectionOf,
  type ConsentFlags,
  type ConsentExclusion,
  consentScopeRequest,
  consentSections,
  consentFlags,
  consentExclusions,
}
