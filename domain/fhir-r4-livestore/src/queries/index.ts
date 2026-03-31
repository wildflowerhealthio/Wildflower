import { queryDb, type LiveQueryDef } from '@livestore/livestore'

import { tables } from '../schema/index.ts'

import { Binary, Patient } from '../resources/index.ts'

const accounts$ = queryDb(tables.accounts, { label: 'accounts' })

const patients$ = queryDb(tables.patients, { label: 'patients' })

const patientById$ = (id: typeof Patient.IdSchema.Type): LiveQueryDef<Patient> =>
  queryDb(tables.patients.where({ id }), { label: 'patientsById' })

const binaries$ = queryDb(tables.binaries, { label: 'binaries' })

const binaryById$ = (id: typeof Binary.IdSchema.Type): LiveQueryDef<Binary> =>
  queryDb(tables.binaries.where({ id }), { label: 'binaryById' })

export { accounts$, patients$, patientById$, binaries$, binaryById$ }
