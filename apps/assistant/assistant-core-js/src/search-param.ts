import { Schema } from 'effect'

/**
 * One FHIR search parameter as the agent gives it: a name, with any
 * modifier or chain (`code:text`, `subject.name`), and a value.
 *
 * @remarks
 * A namespace module: `SearchParam.Schema`, `SearchParam.Type`,
 * `SearchParam.Name`, `SearchParam.baseNameOf`. `search_records` takes a
 * list of them, `PatientPin` adds the one that keeps a search to a patient,
 * and the query string is built from them.
 *
 * @packageDocumentation
 */

/** A search parameter's name: letters, digits, `_`, `-`, and `:` or `.` for modifiers and chains. */
const Name = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_\-:.]*$/u))

/** One search parameter: its name and its value, each as the agent wrote it. */
const SearchParamSchema = Schema.Struct({ name: Schema.String, value: Schema.String })

/** One search parameter. */
type Type = typeof SearchParamSchema.Type

/** The parameter `name` is a modifier or chain of: `subject` for `subject:Patient` or `subject.name`. */
const baseNameOf = (name: string): string => name.split(/[:.]/u)[0] ?? name

export { baseNameOf, Name, SearchParamSchema as Schema }
export type { Type }
