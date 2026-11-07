import {
  type IdentifierAndReference,
  withMandatoryId,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { Patient, type FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, HashMap, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { LinkChoice, LinkPlan, LinkTarget, Mention } from '../index.ts'
import {
  CUSTOMER,
  customerSubject,
  fileOf,
  keyOf,
  patient,
  request,
  runOnTestClock,
  SOURCE_PATIENT,
  STORED_JAN,
  STORED_TYRA,
} from './identity-map.test-helpers.ts'

/**
 * Covers the link plan's lookups: each answered off its index, by the key
 * its question asks with, the first entry under a key winning.
 */

const PERSON = keyOf('Patient', SOURCE_PATIENT, 'p-1')

/** A decoded Patient carrying its own id and the account `c-9`. */
const personWithAccount = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    identifier: [
      { system: SOURCE_PATIENT, value: id },
      { system: CUSTOMER, value: 'c-9' },
    ],
  })

/** The plan over one file of `resources`, every referent on its default choice but those in `choices`. */
const planOf = (
  resources: readonly FhirResourceWithId[],
  choices: ReadonlyArray<readonly [typeof PERSON, LinkChoice.Type]> = []
): LinkPlan.Type =>
  runOnTestClock(LinkPlan.make([fileOf(...resources)], HashMap.fromIterable(choices)))

/** The `subject` of a prescription naming its patient by `subject`. */
const subjectOf = (subject: object): IdentifierAndReference.ReferenceType =>
  Option.getOrThrow(
    Array.findFirst(Mention.madeIn(request('rx-1', subject)), ({ path }) => path === 'subject')
  ).reference

describe('LinkPlan.redirectionIfLinked', () => {
  it('redirects a logical reference by the key of the referent it names', () => {
    const plan = planOf([patient({ id: 'p-1' })])

    expect(
      LinkPlan.redirectionIfLinked(
        plan,
        subjectOf({ type: 'Patient', identifier: { system: SOURCE_PATIENT, value: 'p-1' } })
      )
    ).toEqual(Option.some('Patient/p-1'))
  })

  it('redirects a logical reference exactly one referent answers to, by none’s key', () => {
    const plan = planOf([personWithAccount('p-1')])

    expect(LinkPlan.redirectionIfLinked(plan, subjectOf(customerSubject('c-9')))).toEqual(
      Option.some('Patient/p-1')
    )
  })

  it('leaves a logical reference two referents answer to', () => {
    const plan = planOf([personWithAccount('p-1'), personWithAccount('p-2')])

    expect(LinkPlan.redirectionIfLinked(plan, subjectOf(customerSubject('c-9')))).toEqual(
      Option.none()
    )
  })

  it('redirects a decoded literal reference to the stored resource standing in for it', () => {
    const plan = planOf(
      [patient({ id: 'p-1' })],
      [[PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]]
    )

    expect(LinkPlan.redirectionIfLinked(plan, subjectOf({ reference: 'Patient/p-1' }))).toEqual(
      Option.some(`Patient/${STORED_TYRA.id}`)
    )
  })
})

describe('LinkPlan.linkTargetIfReferentKey', () => {
  it('gives the link target of the referent keyed so, and none for another key', () => {
    const plan = planOf(
      [patient({ id: 'p-1' })],
      [[PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]]
    )

    expect(LinkPlan.linkTargetIfReferentKey(plan, PERSON)).toEqual(
      Option.some(LinkTarget.Stored({ resource: STORED_TYRA }))
    )
    expect(LinkPlan.linkTargetIfReferentKey(plan, keyOf('Patient', SOURCE_PATIENT, 'p-2'))).toEqual(
      Option.none()
    )
  })
})

describe('LinkPlan.linkTargetIfChosenForMention', () => {
  const mentionLink = (
    reviewKey: string,
    resource: typeof STORED_TYRA
  ): LinkPlan.Lists['mentionLinks'][number] => ({
    reviewKey,
    path: Mention.SUBJECT_PATH,
    target: LinkTarget.Stored({ resource }),
  })

  it('finds the mention link by its review key and path, the first under one winning', () => {
    const plan = LinkPlan.fromLists({
      links: [],
      mentionLinks: [mentionLink('k-1', STORED_TYRA), mentionLink('k-1', STORED_JAN)],
      resolvedResources: [],
    })

    expect(LinkPlan.linkTargetIfChosenForMention(plan, 'k-1', Mention.emptySubject)).toEqual(
      Option.some(LinkTarget.Stored({ resource: STORED_TYRA }))
    )
    expect(LinkPlan.linkTargetIfChosenForMention(plan, 'k-2', Mention.emptySubject)).toEqual(
      Option.none()
    )
  })
})
