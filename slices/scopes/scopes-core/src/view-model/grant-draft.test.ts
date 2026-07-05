import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Grant, GrantDraft, Scope, ScopeRequest } from '../index.ts'

const patient = Scope.Contexts.Fhir.patient
const obs = Scope.ResourceType.Fhir.parse('Observation')!
const v2config = Scope.FhirV2.configuration
const cruds = (l: Scope.Permission.Cruds.Interaction[]): Scope.Permission.Cruds =>
  new Scope.Permission.Cruds(l)
const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  new Scope.FhirV2(patient, Scope.ResourceType.Fhir.parse(name)!, cruds(l))
const fhirV1 = (name: string, permission: Scope.Permission.ReadWrite): Scope.FhirV1 =>
  new Scope.FhirV1(patient, Scope.ResourceType.Fhir.parse(name)!, permission)
const grant = (scopes: Scope.Any[]): GrantDraft.GrantDraft => ({
  patient: 'jordan',
  ...Grant.make(scopes),
})

describe('GrantDraft.serialize — dedupe (§3)', () => {
  test('a specific scope omits interactions already in the same-context wildcard', () => {
    expect(
      GrantDraft.serialize(grant([fhirV2('*', ['r']), fhirV2('Observation', ['c', 'r'])]))
    ).toEqual(['patient/*.r', 'patient/Observation.c'])
  })

  test('a specific scope fully covered by the wildcard emits nothing', () => {
    expect(
      GrantDraft.serialize(grant([fhirV2('*', ['r', 's']), fhirV2('Observation', ['r'])]))
    ).toEqual(['patient/*.rs'])
  })

  test('a higher-context wildcard dedupes a lower-context specific row (hierarchical §3)', () => {
    const systemAll = new Scope.FhirV2(
      Scope.Contexts.Fhir.system,
      Scope.ResourceType.Fhir.parse('*')!,
      cruds(['r'])
    )
    // system/*.r covers patient/Observation.r (system ⊇ patient), so the specific row emits
    // nothing — matching the wildcard lock the grid resolves for that cell.
    expect(GrantDraft.serialize(grant([systemAll, fhirV2('Observation', ['r'])]))).toEqual([
      'system/*.r',
    ])
  })

  test('a same-style v1 wildcard dedupes a v1 word row', () => {
    expect(
      GrantDraft.serialize(
        grant([
          fhirV1('*', Scope.Permission.ReadWrite.read),
          fhirV1('Observation', Scope.Permission.ReadWrite.read),
        ])
      )
    ).toEqual(['patient/*.read'])
  })

  test('a Wildflower wildcard does not dedupe a patient FHIR scope', () => {
    const wf: Scope.Wildflower = new Scope.Wildflower(
      new Scope.Contexts.Wildflower(),
      Scope.ResourceType.Wildflower.parse('*')!,
      cruds(['r'])
    )
    expect(GrantDraft.serialize(grant([wf, fhirV2('Observation', ['r'])]))).toContain(
      'patient/Observation.r'
    )
  })
})

describe('GrantDraft.initial — seed from required (§2)', () => {
  test('open mode (null request) starts empty', () => {
    const draft = GrantDraft.initial(null, 'jordan')
    expect(draft.patient).toBe('jordan')
    expect(GrantDraft.serializeAll(draft)).toEqual([])
  })

  test('request mode seeds the draft with the required scopes and flags', () => {
    const request = {
      requested: Grant.make([fhirV2('Observation', ['r', 'c']), Scope.Known.openid]),
      required: Grant.make([fhirV2('Observation', ['r']), Scope.Known.openid]),
    }
    const draft = GrantDraft.initial(request, 'jordan')
    // The required scope/flag are present, so a grid cell the picker locks on is backed by
    // a real grant rather than emitting nothing.
    expect(GrantDraft.serializeAll(draft)).toEqual(['patient/Observation.r', 'openid'])
  })
})

describe('GrantDraft.serializeAll', () => {
  test('appends sorted flags and preserved unknowns', () => {
    const g = grant([
      fhirV2('Observation', ['r']),
      Scope.Known.offlineAccess,
      Scope.Known.openid,
      new Scope.Unknown('mystery_scope'),
    ])
    expect(GrantDraft.serializeAll(g)).toEqual([
      'patient/Observation.r',
      'offline_access',
      'openid',
      'mystery_scope',
    ])
  })
})

// Arbitraries built from the real catalog / flag / interaction vocabularies.
const crudsLetters: readonly Scope.Permission.Cruds.Interaction[] = ['c', 'r', 'u', 'd', 's']
const interactionArb = fc.constantFrom(...crudsLetters)
const resourceNameArb = fc.constantFrom(...Scope.ResourceType.Fhir.catalog)
const flagNameArb = fc.constantFrom(...Scope.Known.Name.all)

/** A `patient/<Resource>.<perms>` v2 scope string over a real catalog resource. */
const fhirScopeStringArb = fc
  .record({ name: resourceNameArb, perms: fc.uniqueArray(interactionArb, { minLength: 1 }) })
  .map(
    ({ name, perms }) =>
      new Scope.FhirV2(
        patient,
        Scope.ResourceType.Fhir.parse(name)!,
        new Scope.Permission.Cruds(perms)
      ).serialize()!
  )

/** A requested scope list: some v2 resource scopes plus some known flags. */
const requestedStringsArb = fc
  .record({
    fhir: fc.array(fhirScopeStringArb, { maxLength: 5 }),
    flags: fc.uniqueArray(flagNameArb),
  })
  .map(({ fhir, flags }) => [...fhir, ...flags])

describe('GrantDraft.fromScopes — all-optional seeding', () => {
  test('round-trips a plain (non-redundant) scope list through serializeAll', () => {
    expect(
      GrantDraft.serializeAll(GrantDraft.fromScopes(['patient/Observation.r', 'openid']))
    ).toEqual(['patient/Observation.r', 'openid'])
  })

  test('every requested scope is checked — parses to Grant.parse(xs)', () => {
    const xs = ['patient/Observation.rc', 'openid', 'offline_access']
    const draft = GrantDraft.fromScopes(xs, 'jordan')
    expect(draft.patient).toBe('jordan')
    // The draft is exactly the parsed grant plus `patient`.
    expect(GrantDraft.serializeAll(draft)).toEqual(
      GrantDraft.serializeAll({ patient: null, ...Grant.parse(xs) })
    )
  })

  test('serializeAll ∘ fromScopes is an idempotent canonicalization (property)', () => {
    fc.assert(
      fc.property(requestedStringsArb, (strings) => {
        const once = GrantDraft.serializeAll(GrantDraft.fromScopes(strings))
        const twice = GrantDraft.serializeAll(GrantDraft.fromScopes(once))
        expect(twice).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('GrantDraft.toggleItem — draft-level cell edit', () => {
  test('toggling an editable cell twice is identity', () => {
    const draft = GrantDraft.fromScopes(['patient/Observation.r'])
    const once = GrantDraft.toggleItem(draft, v2config, patient, obs, 'c')
    const twice = GrantDraft.toggleItem(once, v2config, patient, obs, 'c')
    expect(GrantDraft.serializeAll(twice)).toEqual(GrantDraft.serializeAll(draft))
  })

  test('is a no-op on a wildcard-covered cell', () => {
    const draft = GrantDraft.fromScopes(['patient/*.r'])
    const next = GrantDraft.toggleItem(draft, v2config, patient, obs, 'r')
    expect(GrantDraft.serializeAll(next)).toEqual(GrantDraft.serializeAll(draft))
  })

  test('preserves the patient and other partitions', () => {
    const draft = GrantDraft.fromScopes(['openid'], 'jordan')
    const next = GrantDraft.toggleItem(draft, v2config, patient, obs, 'r')
    expect(next.patient).toBe('jordan')
    expect(next.known.map((k) => k.name)).toContain('openid')
    expect(GrantDraft.serialize(next)).toEqual(['patient/Observation.r'])
  })
})

describe('GrantDraft.toggleFlag — draft-level flag edit', () => {
  test('adds then removes a known flag', () => {
    const added = GrantDraft.toggleFlag(GrantDraft.fromScopes([]), 'openid')
    expect(added.known.map((k) => k.name)).toContain('openid')
    const removed = GrantDraft.toggleFlag(added, 'openid')
    expect(removed.known.map((k) => k.name)).not.toContain('openid')
  })

  test('leaves the resource partitions and patient untouched', () => {
    const draft = GrantDraft.fromScopes(['patient/Observation.r'], 'jordan')
    const next = GrantDraft.toggleFlag(draft, 'offline_access')
    expect(next.patient).toBe('jordan')
    expect(GrantDraft.serialize(next)).toEqual(['patient/Observation.r'])
    expect(next.known.map((k) => k.name)).toContain('offline_access')
  })
})

type Op =
  | {
      readonly kind: 'cell'
      readonly resource: Scope.ResourceType.Fhir
      readonly itemId: Scope.Permission.Cruds.Interaction
    }
  | { readonly kind: 'flag'; readonly name: Scope.Known.Name }

/**
 * A requested scope list plus a sequence of edits, where every edit targets a cell or flag
 * the request itself grants — the operations the disabled-outside-the-request grid actually
 * lets the user perform.
 */
const scenarioArb = requestedStringsArb.chain((strings) => {
  const requested = Grant.parse(strings)
  const ops: Op[] = [
    ...requested.fhirV2.flatMap((scope) =>
      scope.permission
        .toArray()
        .map((itemId): Op => ({ kind: 'cell', resource: scope.resource, itemId }))
    ),
    ...requested.known.map((known): Op => ({ kind: 'flag', name: known.name })),
  ]
  const seqArb =
    ops.length === 0
      ? fc.constant<readonly number[]>([])
      : fc.array(fc.nat(ops.length - 1), { maxLength: 20 })
  return seqArb.map((seq) => ({ strings, ops, seq }))
})

describe('GrantDraft editing stays within the request envelope (property)', () => {
  test('any sequence of requested toggles keeps the draft ⊆ requested', () => {
    fc.assert(
      fc.property(scenarioArb, ({ strings, ops, seq }) => {
        const scopeRequest: ScopeRequest.ScopeRequest = {
          requested: Grant.parse(strings),
          required: Grant.make([]),
        }
        let draft = GrantDraft.fromScopes(strings)
        for (const i of seq) {
          const op = ops[i]
          draft =
            op.kind === 'cell'
              ? GrantDraft.toggleItem(draft, v2config, patient, op.resource, op.itemId)
              : GrantDraft.toggleFlag(draft, op.name)
        }
        expect(ScopeRequest.isWithin(draft, scopeRequest)).toBe(true)
        // The serialized-then-reparsed draft (wildcard dedupe applied) also stays within.
        expect(
          ScopeRequest.isWithin(GrantDraft.fromScopes(GrantDraft.serializeAll(draft)), scopeRequest)
        ).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
