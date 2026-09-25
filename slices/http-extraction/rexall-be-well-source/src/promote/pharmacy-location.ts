import { flow, Option, pipe, Schema, Struct } from 'effect'

import {
  IdentifierAndReference,
  PharmacyStoreLocatorBase,
  storeLocatorUrl,
} from 'fhir-r4/data-types'
import type { Extension } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { Lift } from 'kitchen-sink'

import { CarebookExtension, REXALL_SYSTEM_SOURCE } from '../carebook.ts'
import { DecodedReference } from './decoded-r4.ts'
import { atUrl, promoteExtension } from './extension-lift.ts'

/**
 * Where the dispensing pharmacy is: `medication-processor` → the request's
 * `dispenseRequest.performer` or the dispense's `location`, and the
 * `external-system-source` + `external-store-id` pair → the public Rexall
 * store-locator page, on that same reference's `reference`.
 *
 * @remarks
 * The store number lands on `Reference.reference`, never
 * `Reference.identifier`, which already holds carebook's own pharmacy id — see
 * AGENTS.md under "Extension Promotion".
 */

/** `…/medication-processor`: carebook's reference to the dispensing pharmacy location. */
const PharmacyLocationReference = Schema.pluck(
  Schema.Struct({ valueReference: DecodedReference }),
  'valueReference'
)

/**
 * `common/…/external-system-source`, only when it names Rexall. Any other
 * source is not a Rexall store and decodes to nothing.
 */
const RexallSystemSource = Schema.pluck(
  Schema.Struct({ valueString: Schema.Literal(REXALL_SYSTEM_SOURCE) }),
  'valueString'
)

/** `…/external-store-id`: a Rexall store number, trimmed, never blank. */
const ExternalStoreId = Schema.pluck(
  Schema.Struct({ valueString: Schema.compose(Schema.Trim, Schema.NonEmptyTrimmedString) }),
  'valueString'
)

/**
 * The Rexall store-locator page the `external-system-source` +
 * `external-store-id` pair spells: a Rexall source **and** a store number,
 * consumed together.
 *
 * @param externalStoreIdUrl - The resource's own `external-store-id` url
 * (request and dispense each have one)
 * @remarks
 * Either extension alone is not a store link — a store number from another
 * chain's system would point at the wrong page — so a lone one reads nothing
 * and stays where it is.
 */
const liftStoreLocatorUrl = (externalStoreIdUrl: string): Lift.Lift<string, Extension.Type> =>
  pipe(
    atUrl(CarebookExtension.ExternalSystemSource, RexallSystemSource),
    Lift.zipRight(atUrl(externalStoreIdUrl, ExternalStoreId)),
    Lift.map((storeId) => storeLocatorUrl(PharmacyStoreLocatorBase.Rexall, storeId))
  )

/**
 * The pharmacy location reference pointed at the store-locator page, keeping
 * every other field of it — in particular the `identifier` carrying carebook's
 * own pharmacy id, which the store number must not displace.
 */
const withStoreLocatorUrl = (
  pharmacyLocationReference: IdentifierAndReference.ReferenceType | null,
  storeLocatorPage: string
): IdentifierAndReference.ReferenceType => ({
  ...(pharmacyLocationReference ?? IdentifierAndReference.emptyReference),
  reference: storeLocatorPage,
})

// ---------------------------------------------------------------------------
// MedicationRequest
// ---------------------------------------------------------------------------

/**
 * Edit the request's `dispenseRequest.performer` — or `None` when the request
 * has no `dispenseRequest`. It is optional in the dialect, and a value with
 * nowhere to land must keep its extension (dropping it would destroy the
 * dispensing pharmacy, or the store number, outright).
 */
const withDispensePerformer = (
  request: MedicationRequest.Type,
  performerFrom: (
    currentPerformer: IdentifierAndReference.ReferenceType | null
  ) => IdentifierAndReference.ReferenceType
): Option.Option<MedicationRequest.Type> =>
  pipe(
    Option.fromNullable(request.dispenseRequest),
    Option.map((dispenseRequest) => ({
      ...request,
      dispenseRequest: Struct.evolve(dispenseRequest, { performer: performerFrom }),
    }))
  )

/** `medication-processor` → `dispenseRequest.performer`. */
const liftRequestMedicationProcessor = promoteExtension(
  atUrl(CarebookExtension.RequestMedicationProcessor, PharmacyLocationReference),
  (request: MedicationRequest.Type, pharmacyLocationReference) =>
    withDispensePerformer(request, () => pharmacyLocationReference)
)

/**
 * The store pair → `dispenseRequest.performer.reference`, creating the
 * performer when no `medication-processor` supplied one (the capture's
 * `mr-0002`).
 */
const liftRequestStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.RequestExternalStoreId),
  (request: MedicationRequest.Type, storeLocatorPage) =>
    withDispensePerformer(request, (pharmacyLocationReference) =>
      withStoreLocatorUrl(pharmacyLocationReference, storeLocatorPage)
    )
)

/**
 * Where the request was dispensed: the processor's reference, then the store
 * page on it.
 *
 * @remarks
 * The order is the rule. The processor lands first so that its reference —
 * carrying carebook's pharmacy `identifier` — is already in place for the store
 * link to keep; the other way round, the processor would overwrite the link.
 */
const promoteRequestPharmacy = flow(liftRequestMedicationProcessor, liftRequestStoreLocatorUrl)

// ---------------------------------------------------------------------------
// MedicationDispense
// ---------------------------------------------------------------------------

/**
 * `medication-processor` → `location`, which a dispense always has room for.
 *
 * @remarks
 * `location` rather than `performer` because the reference denotes a
 * `Location`: the request path is `…/pharmacy/Location` and the extension's id
 * is that query's `_id`.
 */
const liftDispenseMedicationProcessor = promoteExtension(
  atUrl(CarebookExtension.DispenseMedicationProcessor, PharmacyLocationReference),
  (dispense: MedicationDispense.Type, pharmacyLocationReference) =>
    Option.some({ ...dispense, location: pharmacyLocationReference })
)

/** The store pair → `location.reference`, mirroring the request's `performer`. */
const liftDispenseStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.DispenseExternalStoreId),
  (dispense: MedicationDispense.Type, storeLocatorPage) =>
    Option.some(
      Struct.evolve(dispense, {
        location: (pharmacyLocationReference) =>
          withStoreLocatorUrl(pharmacyLocationReference, storeLocatorPage),
      })
    )
)

/**
 * Where the dispense happened: the processor's reference, then the store page
 * on it — in that order, for the reason {@link promoteRequestPharmacy} gives.
 */
const promoteDispensePharmacy = flow(liftDispenseMedicationProcessor, liftDispenseStoreLocatorUrl)

export { promoteDispensePharmacy, promoteRequestPharmacy }
