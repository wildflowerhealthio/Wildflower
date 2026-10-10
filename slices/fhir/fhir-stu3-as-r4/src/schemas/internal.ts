import type { Quantity, SimpleQuantity } from 'fhir-r4/data-types'

/**
 * Narrow an R4 `Quantity` back to a carebook `SimpleQuantity`, dropping the
 * R4-only `comparator` slot and unbranding `code`. Callers going R4 → STU3 MUST
 * first confirm `comparator` is absent (the `transformOrFail` encode guards do
 * this) — this helper silently drops it.
 */
const toSimpleQuantity = (
  quantity: typeof Quantity.Schema.Type | null
): typeof SimpleQuantity.Schema.Type | null =>
  quantity === null
    ? null
    : {
        id: quantity.id,
        extension: quantity.extension,
        code: quantity.code,
        system: quantity.system,
        unit: quantity.unit,
        value: quantity.value,
      }

export { toSimpleQuantity }
