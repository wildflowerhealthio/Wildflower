import { Schema } from 'effect'

/**
 * The province that issued a health card: Ontario (`ON`) or British Columbia
 * (`BC`) by its ISO 3166-2 subdivision code, or `Other` for a card from any
 * other province or territory.
 *
 * @remarks
 * Ontario and British Columbia each have their health card naming system in
 * Canada Health Infoway's URI registry and a rule for the shape of a printed
 * number ({@link HealthCardIdentifier.FromPrinted}). `Other` is there so a
 * card from anywhere else can still be written, under a Wildflower-minted
 * system with no rule for its shape. A province gets its own code when a
 * source needs its rule.
 */
const HealthCardProvinceSchema = Schema.Literal('ON', 'BC', 'Other')

type HealthCardProvince = typeof HealthCardProvinceSchema.Type

/** Every {@link HealthCardProvince}, in the order a picker lists them. */
const all: readonly HealthCardProvince[] = HealthCardProvinceSchema.literals

/** Each province's English name, for a picker. */
const names: Readonly<Record<HealthCardProvince, string>> = {
  ON: 'Ontario',
  BC: 'British Columbia',
  Other: 'Other province',
}

/** Whether a string is a {@link HealthCardProvince}: how a `<select>`'s value is read back. */
const is: (value: unknown) => value is HealthCardProvince = Schema.is(HealthCardProvinceSchema)

export { all, HealthCardProvinceSchema as Schema, is, names, type HealthCardProvince as Type }
