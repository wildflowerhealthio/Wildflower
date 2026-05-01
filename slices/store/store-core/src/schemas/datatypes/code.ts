import { Schema } from 'effect'

/**
 * FHIR R4 `code` primitive — a branded string for coded values.
 *
 * @remarks
 * The `type` alias is generic so callers can narrow to a specific value set
 * (e.g. `Code<'active' | 'inactive'>`). The `const` is the Effect Schema.
 */
export const Code = Schema.String.pipe(Schema.brand('code'))
/** Branded string type for FHIR coded values, optionally narrowed to `Value`. */
export type Code<Value extends string = string> = typeof Code.Type & Value
