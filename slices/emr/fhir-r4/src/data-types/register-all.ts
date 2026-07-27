// Registration barrel: importing this runs every registrable datatype module's
// `registerDatatypeSchema(...)` load-time side effect exactly once, so any entry
// that encodes/decodes resources gets a complete registry from one import rather
// than hand-listing modules per resource (the datatype-registry trap in
// slices/emr/AGENTS.md covers why a missing registration is otherwise a
// runtime-only `UnregisteredDatatype`). `register-all.test.ts` asserts this list
// fills every registry slot, so a dropped or forgotten line fails CI. Imports
// only datatype modules — never resources/index — so it is cycle-safe to import
// from any resource. Add a line whenever a new complex datatype module lands.
import './base/meta.ts'
import './complex/address.ts'
import './complex/annotation.ts'
import './complex/attachment.ts'
import './complex/codeable-concept.ts'
import './complex/coding.ts'
import './complex/contact-point.ts'
import './complex/duration.ts'
import './complex/human-name.ts'
import './complex/identifier-and-reference.ts'
import './complex/period.ts'
import './complex/quantity.ts'
import './complex/range.ts'
import './complex/ratio.ts'
import './complex/sampled-data.ts'
import './complex/simple-quantity.ts'
import './complex/timing.ts'
