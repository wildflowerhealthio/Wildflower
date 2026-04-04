import { queryDb } from '@livestore/livestore'

import { tables } from '../schema/index.ts'

import type { Binary, Patient } from '../resources/index.ts'

const patients$ = queryDb(tables.patients, { label: 'patients' })

/* oxlint-disable typescript-eslint/explicit-function-return-type */
const patientById$ = (id: typeof Patient.IdSchema.Type) =>
  queryDb(tables.patients.where({ id }), { map: (rows) => rows[0], label: 'patientsById' })

const binaries$ = queryDb(tables.binaries, { label: 'binaries' })

const binaryById$ = (id: typeof Binary.IdSchema.Type) =>
  queryDb(tables.binaries.where({ id }), { map: (rows) => rows[0], label: 'binaryById' })
/* oxlint-enable typescript-eslint/explicit-function-return-type */

export { patients$, patientById$, binaries$, binaryById$ }
