import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Array as Arr, Option, pipe } from 'effect'

import { isDispense, isHistoryCopy } from './merge-resources.ts'
import { tryPcidFromUrlParam } from './portal-url.ts'

/**
 * The Shoppers source's `linkAcrossResponses`: the history feed's fills of an
 * account that manages one person, filed on that person.
 *
 * @packageDocumentation
 */

type PersonKey = IdentifierAndReference.QualifiedIdentifierType

/**
 * The key of the one Patient a customers response lists, or `None` when its
 * records are not exactly one Patient.
 */
const onePersonOf = (records: readonly DetachedResource.Type[]): Option.Option<PersonKey> =>
  pipe(
    Option.liftPredicate(records, (all) => all.length === 1),
    Option.flatMap(Arr.head),
    Option.filter((record) => record.resourceType === 'Patient'),
    Option.flatMap(DetachedResource.keyIdentifierOf)
  )

/** Whether two person keys name the same Patient. */
const isSamePerson = (first: PersonKey, second: PersonKey): boolean =>
  first.system.href === second.system.href && first.value === second.value

/**
 * Each account's one person in the file, by the account's `pcid`: the key of
 * the one Patient its customers responses list. An account whose customers
 * responses list several people, or disagree on who its one person is, maps
 * to `None`. A response is a customers response when its records include a
 * Patient: only that feed emits them.
 */
const onePersonByAccount = (
  responses: readonly SourceDescriptor.ResponseRecords<DetachedResource.Type>[]
): ReadonlyMap<string, Option.Option<PersonKey>> => {
  const personByAccount = new Map<string, Option.Option<PersonKey>>()
  for (const { url, records } of responses) {
    if (!records.some((record) => record.resourceType === 'Patient')) continue
    const pcid = tryPcidFromUrlParam(url)
    if (Option.isNone(pcid)) continue
    const person = onePersonOf(records)
    const earlier = personByAccount.get(pcid.value)
    personByAccount.set(
      pcid.value,
      earlier === undefined
        ? person
        : Option.flatMap(earlier, (earlierPerson) =>
            Option.filter(person, (laterPerson) => isSamePerson(earlierPerson, laterPerson))
          )
    )
  }
  return personByAccount
}

/**
 * `record` filed on the person keyed by `personKey` when it is a history
 * copy: its `subject` the logical reference to their Patient, as the status
 * feed names a fill's person. Anything else is returned as it is.
 */
const filedOn =
  (personKey: PersonKey) =>
  (record: DetachedResource.Type): DetachedResource.Type =>
    isDispense(record) && isHistoryCopy(record)
      ? {
          ...record,
          subject: {
            ...IdentifierAndReference.emptyReference,
            type: 'Patient',
            identifier: personKey,
          },
        }
      : record

/**
 * The Shoppers responses of one file, the history fills of an account that
 * manages exactly one person filed on that person.
 *
 * @remarks
 * A history fill names only the account (`ShoppersIdentifierSystem.CustomerId`),
 * since the history payload does not say whose fill it is. When the same file
 * holds that account's customers response listing exactly one person, the
 * fills are theirs: each history copy in the history response whose
 * `customerId` is the customers URL's `pcid` is rewritten to name that
 * person's Patient by its `PatientId` key. Both ids are read by
 * `tryPcidFromUrlParam`. An account managing several people, or one with no
 * customers response in the file, keeps its fills naming the account, for a
 * reviewer to file. Runs after `mergeResources`, so a fill the status feed
 * also carried already names its person and is not a history copy.
 */
const linkShoppersResponses: SourceDescriptor.CrossResponseLink<DetachedResource.Type> = (
  responses
) => {
  const personByAccount = onePersonByAccount(responses)
  return responses.map((response) =>
    pipe(
      tryPcidFromUrlParam(response.url),
      Option.flatMap((pcid) => Option.flatten(Option.fromNullable(personByAccount.get(pcid)))),
      Option.match({
        onNone: () => response,
        onSome: (personKey) => ({ ...response, records: response.records.map(filedOn(personKey)) }),
      })
    )
  )
}

export { linkShoppersResponses }
