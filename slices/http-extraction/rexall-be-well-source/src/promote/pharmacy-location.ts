import { Option, pipe, Schema } from 'effect'

import { IdentifierAndReference } from 'fhir-r4/data-types'
import type { Extension } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'

import { CarebookExtension, REXALL_SYSTEM_SOURCE } from '../carebook.ts'
import { DecodedReference } from './decoded-r4.ts'
import { type Lifted, liftExtension, promoteExtension } from './lift.ts'

/**
 * Where the dispensing pharmacy is: `medication-processor` → the request's
 * `dispenseRequest.performer` or the dispense's `location`, and the
 * `external-system-source` + `external-store-id` pair → the public Rexall
 * store-locator URL on that same reference's `reference`.
 *
 * @remarks
 * The store number lands on `Reference.reference`, never
 * `Reference.identifier`, which already holds carebook's own pharmacy id — see
 * AGENTS.md under "Extension Promotion".
 */

/** Base of the public Rexall store-locator page a store number is appended to. */
const REXALL_STORE_LOCATOR_BASE = 'https://www.rexall.ca/storelocator/store/'

/** The public store-locator URL for a Rexall store number. */
const rexallStoreLocatorUrl = (storeId: string): string =>
  `${REXALL_STORE_LOCATOR_BASE}${encodeURIComponent(storeId)}`

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
 * The Rexall store-locator URL the `external-system-source` +
 * `external-store-id` pair spells, lifted as one value.
 *
 * @param externalStoreIdUrl - The resource's own `external-store-id` url
 * (request and dispense each have one)
 * @returns `None` unless the source reads {@link REXALL_SYSTEM_SOURCE} **and**
 * a non-blank store id is present — either one alone is not a store link, so a
 * lone extension is left where it is. Otherwise the URL, with both entries
 * gone from `remaining`.
 */
const liftStoreLocatorUrl =
  (externalStoreIdUrl: string) =>
  (extensions: readonly Extension.Type[]): Option.Option<Lifted<string>> =>
    pipe(
      liftExtension(CarebookExtension.ExternalSystemSource, RexallSystemSource)(extensions),
      Option.flatMap(({ remaining }) =>
        liftExtension(externalStoreIdUrl, ExternalStoreId)(remaining)
      ),
      Option.map(({ value: storeId, remaining }) => ({
        value: rexallStoreLocatorUrl(storeId),
        remaining,
      }))
    )

/**
 * The pharmacy location reference pointed at the store-locator page, keeping
 * every other field of it — in particular the `identifier` carrying carebook's
 * own pharmacy id, which the store number must not displace.
 */
const withStoreLocatorUrl = (
  pharmacyLocationReference: IdentifierAndReference.ReferenceType | null,
  storeLocatorUrl: string
): IdentifierAndReference.ReferenceType => ({
  ...(pharmacyLocationReference ?? IdentifierAndReference.emptyReference),
  reference: storeLocatorUrl,
})

// ---------------------------------------------------------------------------
// MedicationRequest steps
// ---------------------------------------------------------------------------

/**
 * Put `performer` on the request's `dispenseRequest` — or `None` when it has
 * none. `dispenseRequest` is optional in the dialect, and a value with nowhere
 * to land must keep its extension (dropping it would destroy the dispensing
 * pharmacy, or the store number, outright).
 */
const withDispensePerformer = (
  request: MedicationRequest.Type,
  performerFrom: (
    currentPerformer: IdentifierAndReference.ReferenceType | null
  ) => IdentifierAndReference.ReferenceType
): Option.Option<MedicationRequest.Type> =>
  request.dispenseRequest === null
    ? Option.none()
    : Option.some({
        ...request,
        dispenseRequest: {
          ...request.dispenseRequest,
          performer: performerFrom(request.dispenseRequest.performer),
        },
      })

/** `medication-processor` → `dispenseRequest.performer`. */
const liftRequestMedicationProcessor = promoteExtension(
  liftExtension(CarebookExtension.RequestMedicationProcessor, PharmacyLocationReference),
  (request: MedicationRequest.Type, pharmacyLocationReference) =>
    withDispensePerformer(request, () => pharmacyLocationReference)
)

/**
 * The store pair → `dispenseRequest.performer.reference`, creating the
 * performer when no `medication-processor` supplied one (the capture's
 * `mr-0002`). Must run after {@link liftRequestMedicationProcessor}, so a
 * processor's pharmacy identifier is already in place to keep.
 */
const liftRequestStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.RequestExternalStoreId),
  (request: MedicationRequest.Type, storeLocatorUrl) =>
    withDispensePerformer(request, (pharmacyLocationReference) =>
      withStoreLocatorUrl(pharmacyLocationReference, storeLocatorUrl)
    )
)

// ---------------------------------------------------------------------------
// MedicationDispense steps
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
  liftExtension(CarebookExtension.DispenseMedicationProcessor, PharmacyLocationReference),
  (dispense: MedicationDispense.Type, pharmacyLocationReference) =>
    Option.some({ ...dispense, location: pharmacyLocationReference })
)

/**
 * The store pair → `location.reference`, mirroring the request's `performer`.
 * Must run after {@link liftDispenseMedicationProcessor}.
 */
const liftDispenseStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.DispenseExternalStoreId),
  (dispense: MedicationDispense.Type, storeLocatorUrl) =>
    Option.some({ ...dispense, location: withStoreLocatorUrl(dispense.location, storeLocatorUrl) })
)

export {
  liftDispenseMedicationProcessor,
  liftDispenseStoreLocatorUrl,
  liftRequestMedicationProcessor,
  liftRequestStoreLocatorUrl,
}
