import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { localResourceId } from './local-resource-id.ts'

const LOCAL_ID = /^wf-[0-9a-f]{32}$/

describe('localResourceId', () => {
  // -------------------------------------------------------------------------
  // These outputs are the primary keys resources are stored under. If one of
  // these assertions fails, the derivation changed and every resource already
  // in a store is orphaned — that is the failure this test exists to make
  // loud, not a snapshot to refresh.
  // -------------------------------------------------------------------------
  test('pinned vectors — the derivation is persisted wire format', () => {
    expect(localResourceId('https://r4.smarthealthit.org', 'Patient', 'abc-123')).toBe(
      'wf-40950b58dd8c4058433c5348f14b2c9d'
    )
    expect(
      localResourceId('https://wildflowerhealth.io/fhir/sid/rexall-carebook', 'Patient', 'uid-1')
    ).toBe('wf-3c39598c9274726de159c22dd501d3ec')
    expect(
      localResourceId(
        'https://wildflowerhealth.io/fhir/sid/web-trace-session',
        'DocumentReference',
        'rexall-run-1-req-1'
      )
    ).toBe('wf-d4b60c6aaf4d378f95b236d198652b94')
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
        fc.tuple(fc.string(), fc.string(), fc.string()),
        fc.tuple(fc.string(), fc.string(), fc.string()),
        ([systemA, typeA, idA], [systemB, typeB, idB]) => {
          fc.pre(systemA !== systemB || typeA !== typeB || idA !== idB)
          expect(localResourceId(systemA, typeA, idA)).not.toBe(
            localResourceId(systemB, typeB, idB)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
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

  // The `\n` separator with `originalId` last is what makes the encoding
  // unambiguous: a component cannot eat the delimiter and impersonate the next
  // one.
  test('component boundaries are unambiguous', () => {
    expect(localResourceId('https://a.example', 'Patient', 'x')).not.toBe(
      localResourceId('https://a.example\nPatient', '', 'x')
    )
  })
})
