import { DateTime, Option, pipe, String as Str } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'

import type { Medication } from '../medication.ts'
import { descriptionOf } from './description.ts'
import { dinOf } from './din.ts'
import { nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf } from './dispense-request.ts'
import { displayNameOf } from './display-name.ts'
import { noteOf, requesterOf } from './free-text.ts'
import { storeLinkOf, type StoreLink } from './store-link.ts'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = MedicationRequest.Type

/**
 * Map a decoded FHIR `MedicationRequest` onto this package's
 * {@link Medication} value the matchers consume. `fallbackId`
 * supplies a stable React key when the resource carries no `id`.
 */
const medicationRequestToMedication = (
  request: MedicationRequestResource,
  fallbackId: string
): Medication => ({
  id: pipe(
    Option.fromNullable(request.id),
    Option.filter(Str.isNonEmpty),
    Option.getOrElse(() => fallbackId)
  ),
  displayName: displayNameOf(request),
  status: request.status,
  authoredOn: pipe(
    Option.fromNullable(request.authoredOn),
    Option.map(DateTime.formatIso),
    Option.getOrUndefined
  ),
})

/**
 * The display-oriented view of a `MedicationRequest`: the core {@link Medication}
 * (used for sponsorship and interaction matching) plus the extra fields the
 * medication card renders, each read by the accessor of the same name. Any
 * field the resource does not carry is `null`.
 */
interface MedicationView {
  readonly medication: Medication
  /** Drug Identification Number — see {@link dinOf}. */
  readonly din: string | null
  /** Human-readable description or sig — see {@link descriptionOf}. */
  readonly description: string | null
  /** Prescriber display name (`requester.display`). */
  readonly requester: string | null
  /** Newline-joined `note.text` values. */
  readonly note: string | null
  /** `dispenseRequest.numberOfRepeatsAllowed`. */
  readonly repeatsAllowed: number | null
  /** Remaining repeats — see {@link repeatsAvailableOf}. */
  readonly repeatsAvailable: number | null
  /** Estimated next-fill date (ISO) — see {@link nextFillDateOf}. */
  readonly nextFillDate: string | null
  /** The dispensing store's web page — see {@link storeLinkOf}. */
  readonly storeLink: StoreLink | null
}

/**
 * Whether a medication still has a refill to pick up: repeats are allowed and at
 * least one remains. With a refill left the supply-runout date is the next fill;
 * with none, that date is simply when the supply is exhausted.
 */
const hasRefill = (view: MedicationView): boolean =>
  view.repeatsAllowed !== null && view.repeatsAllowed > 0 && (view.repeatsAvailable ?? 0) > 0

/** Build the rich {@link MedicationView} for one request. */
const medicationRequestToMedicationView = (
  request: MedicationRequestResource,
  fallbackId: string
): MedicationView => ({
  medication: medicationRequestToMedication(request, fallbackId),
  din: dinOf(request),
  description: descriptionOf(request),
  requester: requesterOf(request),
  note: noteOf(request),
  repeatsAllowed: repeatsAllowedOf(request),
  repeatsAvailable: repeatsAvailableOf(request),
  nextFillDate: nextFillDateOf(request),
  storeLink: storeLinkOf(request),
})

/** Map a bundle's worth of requests, deriving fallback keys from position. */
const medicationRequestsToMedications = (
  requests: readonly MedicationRequestResource[]
): readonly Medication[] =>
  requests.map((request, index) =>
    medicationRequestToMedication(request, `medication-request-${index}`)
  )

/** Map a bundle's worth of requests to rich {@link MedicationView}s. */
const medicationRequestsToMedicationViews = (
  requests: readonly MedicationRequestResource[]
): readonly MedicationView[] =>
  requests.map((request, index) =>
    medicationRequestToMedicationView(request, `medication-request-${index}`)
  )

export {
  hasRefill,
  medicationRequestToMedication,
  medicationRequestsToMedications,
  medicationRequestToMedicationView,
  medicationRequestsToMedicationViews,
  type MedicationRequestResource,
  type MedicationView,
}
