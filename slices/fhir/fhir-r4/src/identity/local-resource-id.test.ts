import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { joinIdComponents, localResourceId } from './local-resource-id.ts'

const LOCAL_ID = /^wf-[0-9a-f]{32}$/

/**
 * A generator that can emit the component separator.
 *
 * @remarks
 * `fc.string()` never emits `:` or a digit run adjacent to one, and never emits
 * `\n` at all — so a property written over it cannot reach the boundary cases
 * the encoding exists to handle, and passes without exercising them. Drawing
 * from a tiny alphabet built out of the encoding's own metacharacters is what
 * makes the distinctness property below load-bearing.
 */
const separatorProne = fc
  .array(fc.constantFrom('a', '\n', ':', '0', '1', '2'), { maxLength: 8 })
  .map((characters) => characters.join(''))

describe('joinIdComponents', () => {
  test('length-prefixes each component', () => {
    expect(joinIdComponents(['a', 'bc'])).toBe('1:a2:bc')
    expect(joinIdComponents([])).toBe('')
    expect(joinIdComponents([''])).toBe('0:')
  })

  // The whole point of the encoding. A delimiter join collapses these two —
  // `\n`-joining both gives `a\nb\nc` — and length-prefixing separates them.
  test('a component cannot eat the delimiter and impersonate the next one', () => {
    expect(joinIdComponents(['a', 'b\nc'])).not.toBe(joinIdComponents(['a\nb', 'c']))
    expect(joinIdComponents(['a', 'b:c'])).not.toBe(joinIdComponents(['a:b', 'c']))
  })

  // The general statement of the above: the encoding is injective, so no two
  // distinct component lists can hash to the same thing further down.
  test('distinct component lists get distinct encodings', () => {
    fc.assert(
      fc.property(
        fc.array(separatorProne, { maxLength: 4 }),
        fc.array(separatorProne, { maxLength: 4 }),
        (left, right) => {
          fc.pre(
            left.length !== right.length || left.some((value, index) => value !== right[index])
          )
          expect(joinIdComponents(left)).not.toBe(joinIdComponents(right))
        }
      ),
      { numRuns: numRunsFor({ base: 500 }) }
    )
  })

  // Why `traceResourceId` can fold its pair into one `originalId` without the
  // nesting reintroducing an ambiguity at the outer level.
  test('nests safely — a joined component is delimited by its own prefix', () => {
    expect(joinIdComponents([joinIdComponents(['a', 'b']), 'c'])).not.toBe(
      joinIdComponents([joinIdComponents(['a', 'b', 'c'])])
    )
  })
})

describe('localResourceId', () => {
  // -------------------------------------------------------------------------
  // These outputs are the primary keys resources are stored under. If one of
  // these assertions fails, the derivation changed and every resource already
  // in a store is orphaned — that is the failure this test exists to make
  // loud, not a snapshot to refresh.
  // -------------------------------------------------------------------------
  test('pinned vectors — the derivation is persisted wire format', () => {
    expect(localResourceId('https://r4.smarthealthit.org', 'Patient', 'abc-123')).toBe(
      'wf-8dbbb24323c6b52abc40061152376d5d'
    )
    expect(
      localResourceId('https://wildflowerhealth.io/fhir/sid/rexall-carebook', 'Patient', 'uid-1')
    ).toBe('wf-71ac4133067c57b6ca631c7748f55625')
    expect(
      localResourceId(
        'https://wildflowerhealth.io/fhir/sid/web-trace-session',
        'DocumentReference',
        joinIdComponents(['rexall-run-1', 'req-1'])
      )
    ).toBe('wf-d65e559b43d31313b36e16aa6504af46')
  })

  test('is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (system, resourceType, originalId) => {
        expect(localResourceId(system, resourceType, originalId)).toBe(
          localResourceId(system, resourceType, originalId)
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  // The legality guarantee: whatever goes in — spaces, newlines, unicode, an
  // id far past FHIR's 64-char cap — what comes out is inside FHIR R4's id
  // grammar `[A-Za-z0-9\-.]{1,64}`.
  test('always produces a legal FHIR R4 id', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme' }),
        fc.string({ unit: 'grapheme' }),
        fc.string({ unit: 'grapheme', maxLength: 500 }),
        (system, resourceType, originalId) => {
          const id = localResourceId(system, resourceType, originalId)
          expect(id).toMatch(LOCAL_ID)
          expect(id.length).toBeLessThanOrEqual(64)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('distinct triples get distinct ids', () => {
    fc.assert(
      fc.property(
        fc.tuple(separatorProne, separatorProne, separatorProne),
        fc.tuple(separatorProne, separatorProne, separatorProne),
        ([systemA, typeA, idA], [systemB, typeB, idB]) => {
          fc.pre(systemA !== systemB || typeA !== typeB || idA !== idB)
          expect(localResourceId(systemA, typeA, idA)).not.toBe(
            localResourceId(systemB, typeB, idB)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 500 }) }
    )
  })

  // The rexall case in miniature: one source id shared by a MedicationRequest
  // and its MedicationDispense. The resource type is a hash input, so the two
  // cannot collapse onto one row.
  test('the resource type separates a shared source id', () => {
    const system = 'https://wildflowerhealth.io/fhir/sid/rexall-carebook'
    expect(localResourceId(system, 'MedicationRequest', 'shared-1')).not.toBe(
      localResourceId(system, 'MedicationDispense', 'shared-1')
    )
  })

  // Two servers that both call a patient `1` must not clobber each other.
  test('the source system separates a shared id', () => {
    expect(localResourceId('https://a.example/fhir', 'Patient', '1')).not.toBe(
      localResourceId('https://b.example/fhir', 'Patient', '1')
    )
  })

  // -------------------------------------------------------------------------
  // The case that actually probes component boundaries: one component *eating*
  // the delimiter, so both triples join to the same string. Under the previous
  // `\n`-joined encoding these two collided outright — both spelled
  // `a\nb\nc\nx`, and both returned `wf-cf864ef0771427ad6c04ec5454814bc2`. The
  // length prefix is what separates them, and no precondition on the caller is
  // needed for it to hold.
  //
  // A triple that merely differs by an extra separator (`('a', 'b', 'x')` vs
  // `('a\nb', '', 'x')`) is *not* this test: those are different strings under
  // any encoding, so asserting they differ passes for a trivial reason.
  // -------------------------------------------------------------------------
  test('a component cannot eat the delimiter and impersonate the next one', () => {
    expect(localResourceId('a', 'b\nc', 'x')).not.toBe(localResourceId('a\nb', 'c', 'x'))
    expect(localResourceId('a', 'b:c', 'x')).not.toBe(localResourceId('a:b', 'c', 'x'))
  })
})
