import { queryDb } from '@livestore/livestore'

import { tables } from './schema'

// Re-export FHIR resource queries
export { patients$, patientById$, binaries$, binaryById$ } from 'fhir-r4-livestore/queries'

// App-level queries
const remotes$ = queryDb(tables.remotes, { label: 'remotes' })

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const remoteById$ = (id: string) =>
  queryDb(tables.remotes.where({ id }), { map: (rows) => rows[0], label: 'remoteById' })

export { remotes$, remoteById$ }
