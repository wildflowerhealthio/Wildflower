import { Option, pipe, String as Str } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'

/** A link to the dispensing store's public web page: where it goes, and what it reads. */
interface StoreLink {
  readonly url: string
  readonly label: string
}

const parseUrl = Option.liftThrowable((reference: string) => new URL(reference))

/**
 * Whether a reference is a web page a person can open: an absolute `http(s)`
 * URL, not a relative FHIR reference such as `Location/123`.
 */
const isWebPage = (reference: string): boolean =>
  Option.exists(
    parseUrl(reference),
    ({ protocol }) => protocol === 'http:' || protocol === 'https:'
  )

/**
 * The store the request was dispensed from, when `dispenseRequest.performer`
 * references its web page — the slot the pharmacy sources write a store's
 * public store-locator page to. The link reads as the performer's `display`,
 * else as the URL itself.
 */
const storeLinkOf = (request: MedicationRequest.Type): StoreLink | null =>
  pipe(
    Option.fromNullable(request.dispenseRequest?.performer),
    Option.flatMap((performer) =>
      pipe(
        Option.fromNullable(performer.reference),
        Option.filter(isWebPage),
        Option.map((url) => ({
          url,
          label: pipe(
            Option.fromNullable(performer.display),
            Option.filter(Str.isNonEmpty),
            Option.getOrElse(() => url)
          ),
        }))
      )
    ),
    Option.getOrNull
  )

export { storeLinkOf, type StoreLink }
