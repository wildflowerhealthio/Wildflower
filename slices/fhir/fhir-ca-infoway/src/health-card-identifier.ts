import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Match, Option } from 'effect'

import type * as HealthCardProvince from './health-card-province.ts'

/**
 * Each province's health card number naming system, from Canada Health
 * Infoway's Canadian URI Registry: the `Identifier.system` a health card
 * number is written under.
 *
 * @remarks
 * **Persisted wire format.** A record keyed by a health card number is stored
 * under an id derived from this system, so changing one re-keys every such
 * record already stored.
 */
const HealthCardNumberSystem: Readonly<Record<HealthCardProvince.Type, string>> = {
  /** Ontario's health card number (HCN), less its version code. */
  ON: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-on-patient-hcn',
  /** British Columbia's Personal Health Number (PHN). */
  BC: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-bc-patient-healthcare-id',
}

/**
 * Ontario Health's health card version code extension
 * (`HCNVersionCode`, package `ca.on.oh-setp`): on a `Patient.identifier`, the
 * version code (`valueString`) of the card the number was read from.
 */
const ONTARIO_HEALTH_CARD_VERSION_CODE_URL =
  'http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code'

/**
 * A health card number as an `Identifier` on the wire: always with its
 * `system` and `value`, so a source can key a record by it.
 */
type HealthCardIdentifier = typeof IdentifierAndReference.IdentifierSchema.Encoded & {
  readonly system: string
  readonly value: string
}

/**
 * A printed Ontario health card number split into its number and its version
 * code, the one or two letters after the last digit, with any whitespace
 * before them (`1234567890 AB`). A number printed with no version code has
 * none.
 */
const ONTARIO_VERSION_CODE = /^(?<number>.*\d)\s*(?<versionCode>[A-Za-z]{1,2})$/

const ontarioHealthCardIdentifier = (printed: string): HealthCardIdentifier =>
  Option.fromNullable(ONTARIO_VERSION_CODE.exec(printed)?.groups).pipe(
    Option.match({
      onNone: () => ({ system: HealthCardNumberSystem.ON, value: printed }),
      onSome: ({ number, versionCode }) => ({
        system: HealthCardNumberSystem.ON,
        value: number,
        extension: [{ url: ONTARIO_HEALTH_CARD_VERSION_CODE_URL, valueString: versionCode }],
      }),
    })
  )

/**
 * A health card number as printed, as the `Identifier` its province writes it
 * as.
 *
 * @param province - The province that issued the card
 * @param printed - The number as the source prints it
 * @returns The identifier in the province's {@link HealthCardNumberSystem}:
 *   Ontario's number in `value` with its version code, when it prints one, in
 *   the {@link ONTARIO_HEALTH_CARD_VERSION_CODE_URL} extension; British
 *   Columbia's PHN in `value`, which has no version code
 *
 * @remarks
 * Written as printed after that split, with no check that it is a valid
 * number: a source reports what a card says, and is not the registry that
 * issued it.
 */
const of = (province: HealthCardProvince.Type, printed: string): HealthCardIdentifier =>
  Match.value(province).pipe(
    Match.when('ON', () => ontarioHealthCardIdentifier(printed)),
    Match.when('BC', () => ({ system: HealthCardNumberSystem.BC, value: printed })),
    Match.exhaustive
  )

export {
  HealthCardNumberSystem,
  of,
  ONTARIO_HEALTH_CARD_VERSION_CODE_URL,
  type HealthCardIdentifier as Type,
}
