import { Schema } from 'effect'

/**
 * A province whose health card numbers this package names, by its ISO 3166-2
 * subdivision code: Ontario (`ON`) and British Columbia (`BC`).
 *
 * @remarks
 * Not every province: each one here has its health card naming system in
 * Canada Health Infoway's URI registry and its rule for writing a printed
 * number ({@link HealthCardIdentifier.of}). Another province is added when a
 * source needs it.
 */
const HealthCardProvinceSchema = Schema.Literal('ON', 'BC')

type HealthCardProvince = typeof HealthCardProvinceSchema.Type

/** Every {@link HealthCardProvince}, in the order a picker lists them. */
const all: readonly HealthCardProvince[] = HealthCardProvinceSchema.literals

/** Each province's English name, for a picker. */
const names: Readonly<Record<HealthCardProvince, string>> = {
  ON: 'Ontario',
  BC: 'British Columbia',
}

/** Whether a string is a {@link HealthCardProvince}: how a `<select>`'s value is read back. */
const is: (value: unknown) => value is HealthCardProvince = Schema.is(HealthCardProvinceSchema)

export { all, HealthCardProvinceSchema as Schema, is, names, type HealthCardProvince as Type }
