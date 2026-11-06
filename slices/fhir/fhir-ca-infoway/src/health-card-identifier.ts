import { IdentifierAndReference, narrowFields } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, ParseResult, Schema } from 'effect'

import type * as HealthCardProvince from './health-card-province.ts'

/**
 * Each province's health card number naming system: the `Identifier.system`
 * a health card number is written under. Ontario's and British Columbia's are
 * from Canada Health Infoway's Canadian URI Registry.
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
  /**
   * A health card number from any other province or territory, in a
   * Wildflower-minted system: the registry names only each jurisdiction's own
   * system, and has none for a number whose jurisdiction is not known.
   */
  Other: 'https://wildflowerhealth.io/fhir/sid/health-card-number',
}

/**
 * Ontario Health's health card version code extension
 * (`HCNVersionCode`, package `ca.on.oh-setp`): on a `Patient.identifier`, the
 * version code (`valueString`) of the card the number was read from.
 */
const ONTARIO_HEALTH_CARD_VERSION_CODE_URL =
  'http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code'

/**
 * HL7 v2 table 0203's Jurisdictional health number (`JHN`), the identifier
 * type CA Baseline gives a health card number: the `type` of an `Other`
 * number, whose Wildflower-minted system alone does not say what it is.
 */
const JURISDICTIONAL_HEALTH_NUMBER_TYPE = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
      code: 'JHN',
      display: 'Jurisdictional health number (Canada)',
    },
  ],
}

/**
 * A health card number as an `Identifier` on the wire: always with its
 * `system` and a non-empty `value`, so a source can key a record by it.
 */
const HealthCardIdentifierSchema = narrowFields(
  Schema.encodedSchema(IdentifierAndReference.IdentifierSchema),
  { system: Schema.String, value: Schema.NonEmptyString }
)

type HealthCardIdentifier = typeof HealthCardIdentifierSchema.Type

/**
 * A whole Ontario health card, its separators stripped: the ten-digit number,
 * then the version code of one or two letters when the card prints one.
 */
const ONTARIO_HEALTH_CARD = /^(?<number>\d{10})(?<versionCode>[A-Za-z]{1,2})?$/

/** A British Columbia PHN, its separators stripped: exactly ten digits. */
const BRITISH_COLUMBIA_PHN = /^\d{10}$/

/**
 * How one province's printed number becomes its identifier.
 *
 * @remarks
 * Each rule checks the number's shape only: neither Ontario's nor British
 * Columbia's check digit is verified (#1523), so a misread number with the
 * right shape still decodes. `Other` has no shape to check: any number but an
 * empty one is written as printed, letters and all (a Québec RAMQ number
 * starts with four), and no version code is split off.
 */
interface PrintedRule {
  /** The identifier a number less its separators is; `None` when it is not this province's shape. */
  readonly identifierOf: (card: string) => Option.Option<HealthCardIdentifier>
  /** The failure message for a number that is not, naming the shape expected. */
  readonly expected: string
}

const PrintedRules: Readonly<Record<HealthCardProvince.Type, PrintedRule>> = {
  ON: {
    identifierOf: (card) =>
      Option.fromNullable(ONTARIO_HEALTH_CARD.exec(card)?.groups).pipe(
        Option.map(({ number, versionCode }) => ({
          system: HealthCardNumberSystem.ON,
          value: number,
          ...Option.match(Option.fromNullable(versionCode), {
            onNone: () => ({}),
            onSome: (code) => ({
              extension: [{ url: ONTARIO_HEALTH_CARD_VERSION_CODE_URL, valueString: code }],
            }),
          }),
        }))
      ),
    expected:
      'not an Ontario health card number: expected exactly ten digits, then a version code of up to two letters',
  },
  BC: {
    identifierOf: (card) =>
      Option.liftPredicate(card, (phn) => BRITISH_COLUMBIA_PHN.test(phn)).pipe(
        Option.map((phn) => ({ system: HealthCardNumberSystem.BC, value: phn }))
      ),
    expected: 'not a British Columbia PHN: expected exactly ten digits',
  },
  Other: {
    identifierOf: (card) =>
      Option.liftPredicate(card, (number) => number !== '').pipe(
        Option.map((number) => ({
          system: HealthCardNumberSystem.Other,
          type: JURISDICTIONAL_HEALTH_NUMBER_TYPE,
          value: number,
        }))
      ),
    expected: 'not a health card number: expected something besides spaces and hyphens',
  },
}

/** A printed number less the spaces and hyphens it may be printed with, anywhere in it. */
const withoutSeparators = (printed: string): string => printed.replaceAll(/[\s-]/g, '')

/** An identifier as its card prints it: the number, then the version code when it has one. */
const printedOf = (identifier: HealthCardIdentifier): string =>
  [
    identifier.value,
    ...(identifier.extension ?? []).flatMap(({ url, valueString }) =>
      url === ONTARIO_HEALTH_CARD_VERSION_CODE_URL && valueString !== undefined ? [valueString] : []
    ),
  ].join(' ')

/**
 * A health card number as printed ⇄ the `Identifier` its province writes it
 * as.
 *
 * @param province - The province that issued the card
 * @returns A schema that decodes the printed number, less any spaces and
 *   hyphens, into an identifier in the province's
 *   {@link HealthCardNumberSystem}: Ontario's ten digits in `value` and its
 *   version code, when it prints one, in the
 *   {@link ONTARIO_HEALTH_CARD_VERSION_CODE_URL} extension; British
 *   Columbia's ten-digit PHN in `value`; an `Other` number in `value`,
 *   typed {@link JURISDICTIONAL_HEALTH_NUMBER_TYPE}. Decoding fails when the
 *   number is not that province's shape (for `Other`, when nothing is left),
 *   with a message naming the shape expected, so a wrong province choice
 *   reads as one. Encoding gives the printed form back
 *   (`1234567890 AB`), and fails for an identifier in another system.
 */
const FromPrinted = (
  province: HealthCardProvince.Type
): Schema.Schema<HealthCardIdentifier, string> => {
  const { identifierOf, expected } = PrintedRules[province]
  const system = HealthCardNumberSystem[province]
  return Schema.transformOrFail(Schema.String, HealthCardIdentifierSchema, {
    strict: true,
    decode: (printed, _, ast) =>
      Option.match(identifierOf(withoutSeparators(printed)), {
        onNone: () => ParseResult.fail(new ParseResult.Type(ast, printed, expected)),
        onSome: ParseResult.succeed,
      }),
    encode: (identifier, _, ast) =>
      identifier.system === system
        ? ParseResult.succeed(printedOf(identifier))
        : ParseResult.fail(
            new ParseResult.Type(ast, identifier, `not a health card number in ${system}`)
          ),
  }).annotations({ identifier: `HealthCardIdentifier.FromPrinted('${province}')` })
}

export {
  FromPrinted,
  HealthCardNumberSystem,
  JURISDICTIONAL_HEALTH_NUMBER_TYPE,
  ONTARIO_HEALTH_CARD_VERSION_CODE_URL,
  HealthCardIdentifierSchema as Schema,
  type HealthCardIdentifier as Type,
}
